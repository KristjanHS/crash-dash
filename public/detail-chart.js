/*
 * detail-chart.js — Zone D detail-chart render layer (DOM-free).
 *
 * Kept separate from app.js so these render functions are unit-testable in Node/vitest
 * (no jsdom). Each entry point RETURNS `{ svg, detail }` instead of mutating a global:
 * `svg` is the chart markup string, `detail` is the pointer-readout `{ n, samples }`
 * the caller slots into the `zoneD.details` array (one entry per stacked chart).
 */

import { extent, pathD, stepPathD } from "./sparkline.js";
import { havenEnvelope } from "./haven-envelope.js";
import { recessionProbabilityPct } from "./probit.js";
import {
  CH,
  COMPACT_CH,
  plotW,
  plotH,
  RIBBON_H,
  ribbonTop,
  DETAIL_LIMIT,
  xAt,
  yAt,
  esc,
  formatValue,
  STATE_LETTER,
  formatDerived,
  formatMagnitude,
  STATE_COLORS,
  legPhrase,
  chartOpen,
  hoverLayer,
  STACK_AXIS_X,
  STACK_NAME_X,
  NAME_BAND_L,
  LANE_GAP,
  axisNameY,
  compactDate,
} from "./chart-primitives.js";
import { idIfDistinct } from "./leading-name.js";
import { INDICATOR_DESC } from "./indicator-desc.js";

/**
 * The spelled-out per-observation word for a POINT COUNT in a legend ("N days", "N weeks").
 * Resolves the OBSERVATION grid — `obsCadence ?? cadence` — never `cadence` alone: `cadence`
 * is the RELEASE schedule (`src/api/types.ts`), so a weekly-RELEASED, business-day-OBSERVED id
 * would be captioned in weeks against a grid of trading days. Server-side twin:
 * `obsWord` in `src/chart-rail.ts`, which emits the short forms ("w"/"mo"/"q"/"d") off the
 * same expression — the vocabulary here is its spelled-out counterpart, arm for arm.
 *
 * Exported for `public/velocity-span.test.js`, which sweeps every live id and pins the word this
 * returns against the registry-declared grid — nothing else can see a caption change silently.
 */
export function obsUnitWord(meta) {
  const obs = meta.obsCadence ?? meta.cadence;
  return obs === "quarterly" ? "quarter" : obs === "monthly" ? "month" : obs === "weekly" ? "week" : "day";
}

/** A level DIFFERENCE with its unit named: percentage points ("pp") or basis points ("bp") — a bare
 *  number or a "%" suffix reads as a relative change. Any other unit falls through to `formatValue`. */
export function formatLevelDelta(v, unit) {
  if (v == null) return "-";
  if (unit === "pp") return `${v.toFixed(2)}pp`;
  if (unit === "bp") return `${formatValue(v, "")}bp`;
  return formatValue(v, unit);
}

/**
 * Gap-broken polyline path: null values break the line into runs, so a lookback/warm-up/feed
 * gap renders as a BREAK, never a segment through zero. `scale(v)` maps a value to its y pixel.
 * The ONE path builder every axis uses.
 */
function gapPathFor(arr, n, scale, geo, step = false) {
  let path = "";
  let run = [];
  const flush = () => {
    if (run.length) path += (step ? stepPathD(run) : pathD(run)) + " ";
    run = [];
  };
  arr.forEach((v, i) => {
    if (v == null) flush();
    else run.push([xAt(i, n, geo), scale(v)]);
  });
  flush();
  return path.trim();
}

/**
 * A rotated axis NAME, bottom-up in a margin lane. ONE emitter for both axes so the pair can never
 * drift: the primary sits in the left margin at `STACK_AXIS_X` (just right of the chart's own
 * rotated name), the secondary in the right margin at `w - 3`. Both are pinned to `axisNameY` —
 * the plot floor — so they read as axis captions while the chart name stays vertically centred.
 * `text-anchor` is NOT set here: a presentation attribute loses to `.chart .axis-y`'s CSS anchor,
 * so `.axis-name` owns it (start ⇒ the text begins at the floor and runs up).
 */
function axisName(label, x, geo) {
  const y = axisNameY(geo);
  return `<text class="axis-name" transform="rotate(-90 ${x} ${y})" x="${x}" y="${y}">${esc(label)}</text>`;
}

/** The PRIMARY axis' name in the left margin — `showHead` (stack) frames only, where the chart has
 *  no caption block above it and the legend is re-slotted below the whole stack. A label-less
 *  caller passes "" and gets nothing. */
function axis1Label(label, geo) {
  return geo.showHead && label ? axisName(label, STACK_AXIS_X, geo) : "";
}

/**
 * Shared RIGHT-axis (secondary) machinery for the derived-kind layout: the bespoke
 * scorers (F4/G1/NVDA/F5) decide on a derived quantity, so its bands need their own scale.
 *
 * Band labels sit on the RIGHT, beside the axis they annotate, so they never land over
 * the left axis's ticks.
 *
 * `series` is the per-index right-axis array (may hold `null` lookback gaps);
 * `bands` is the already-present `[kind, value]` list; `label`/`unit` name the axis;
 * `format(v, unit)` renders band + tick values (defaults to `formatDerived`).
 *
 * The bands ARE the reference the line is judged against, so they are folded into the
 * domain and always drawn on-plot. An all-null series falls back to the band values,
 * keeping the fresh-DB numeric anchor.
 *
 * Returns `scale(v)` (px for a right-axis value), `pathFor(arr)` (a gap-broken,
 * pre-trimmed path), `bandSvg`, `yTicks2`, `axis2Label`, `showAxis2`, and `lo`/`hi`
 * (the padded domain, for a caller scaling a perPoint cut off-domain without folding it in).
 */
export function secondaryAxis({ series, bands, label, unit, n, format = formatDerived, geo = CH }) {
  const PW = plotW(geo);
  const PH = plotH(geo);
  const defined = series.filter((v) => v != null);
  const bandVals = bands.map(([, v]) => v);
  const domainSrc = [...defined, ...bandVals];
  const [srcLo, srcHi] = domainSrc.length ? extent(domainSrc) : [0, 1];

  let [dlo, dhi] = [srcLo, srcHi];
  const dPad = (dhi - dlo) * 0.08 || Math.abs(dhi) * 0.1 || 1;
  dlo -= dPad;
  dhi += dPad;
  const scale = (v) => yAt(v, dlo, dhi, geo);

  // A right-axis series line, broken into runs so a null lookback gap shows as a break.
  const pathFor = (arr) => gapPathFor(arr, n, scale, geo);

  const bandColor = (kind) => (kind === "red" ? "var(--state-red)" : "var(--state-amber)");
  // A band tuple may carry an optional 3rd element — a custom label (F1's ARM-ROC cut) —
  // which wins over the "<kind> <value>" auto-label, and an optional 4th — the spec's
  // `style` ("approach" renders its LINE at half strength; the label stays full-strength —
  // half-opacity amber text was unreadable on the dark theme).
  // genericDerived threads `band.label` through as the 3rd element too (DISP's
  // "red <−2.5% · corr>0.75"); ids whose bands declare no label pass undefined here and
  // keep the auto-label byte-identical.
  const bandLabel = (kind, v, y, label) =>
    `<text class="band-label" x="${geo.ml + PW - 2}" y="${y.toFixed(1)}" text-anchor="end" fill="${bandColor(kind)}">${label != null ? esc(label) : `${kind} ${esc(format(v, unit))}`}</text>`;

  const bandSvg = bands
    .map(([kind, v, label, style]) => {
      const y = scale(v);
      const faint = style === "approach" ? ' opacity=".5"' : "";
      return `<line class="band"${faint} x1="${geo.ml}" y1="${y.toFixed(1)}" x2="${geo.ml + PW}" y2="${y.toFixed(1)}"
          stroke="${bandColor(kind)}" stroke-dasharray="4 3" />
        ${bandLabel(kind, v, y - 3, label)}`;
    })
    .join("");
  // The STATIC secondary-band y's (S4 parking): these lines are folded into the domain above, so
  // every band is always in-frame — one y per band, at the same `scale(v)` the line is drawn at.
  const bandYs = bands.map(([, v]) => scale(v));

  // Show the derived domain ticks + axis label whenever a band or line is on screen,
  // so the bands always have a numeric anchor — even on a fresh DB where the line
  // hasn't accrued yet.
  //
  // A tick and a band label are both right-anchored at the same x and sit 6px apart in
  // y, so a band ON a domain end overprints its own tick. The bands are folded into the
  // domain, so any cut left unbreached across the window BECOMES an end: F5 permanently
  // (`highDist` maxes at 0 by construction, and its amber cut is 0), F4/G1/NVDA whenever
  // the regime is calm. Drop such a tick — the band label already prints that number, in
  // its own colour.
  const TICK_CLEAR_PX = 12; // ~one 10px text line
  const showAxis2 = defined.length > 0 || bandVals.length > 0;
  const yTicks2 = showAxis2
    ? [srcLo, srcHi]
        .filter((v) => !bands.some(([, bv]) => Math.abs(scale(bv) - scale(v)) < TICK_CLEAR_PX))
        .map((v) => `<text class="axis-y" x="${geo.ml + PW - 2}" y="${(scale(v) + 3).toFixed(1)}" text-anchor="end" fill="var(--ink-dim)">${esc(format(v, unit))}</text>`)
        .join("")
    : "";
  const axis2Label = showAxis2 ? axisName(label, geo.w - 3, geo) : "";

  // `lo`/`hi` = the padded secondary domain, so a caller can scale a perPoint cut against this axis
  // WITHOUT the cut joining `domainSrc` (D0-a: R7's four moving cuts scale here but never drag it).
  return { scale, pathFor, bandSvg, bandYs, yTicks2, axis2Label, showAxis2, lo: dlo, hi: dhi };
}

// --- served estimate tail (estimateSlot; slot `eff.oasEst` = the wire's `oilEst`, any id with an estimated tail) — derived value-line layout ---
// A served `eff.oasEst` appends ONE virtual value-less x-slot so the dashed neutral estimate fits
// on-plot; active only when it chains off the LAST real point's own date (`valueSpec` = the value line).
// A trailing `estimated` point (/api/series: the stored E3 marker, intraday or EOD)
// is not a close: when `est` chains off the FINAL point before the whole trailing
// `estimated` run (a 2+ day tail, as `estimateSlot` anchors it), the estimate slot REPLACES that run.
// `pts` = the points the layout draws (virtual slot included).
function estimateState(eff, valueSpec, allPts) {
  const est = eff?.oasEst ?? null;
  const n0 = allPts.length;
  let k = n0;
  while (k > 1 && allPts[k - 1].estimated === true) k--;
  const base = k < n0 && allPts[k - 1].date === est?.fromDate ? allPts.slice(0, k) : allPts;
  const estActive =
    est != null &&
    valueSpec?.fromPoint === "value" &&
    Number.isFinite(est.value) &&
    typeof est.date === "string" &&
    typeof est.fromDate === "string" &&
    est.date > est.fromDate &&
    base.length > 0 &&
    base[base.length - 1].date === est.fromDate;
  return { est, estActive, pts: estActive ? [...base, { date: est.date }] : allPts };
}

// Every daytime estimate — a row or slot carrying `provisional` as well as `estimated`, an intraday run's or one the EOD
// cleaner kept (a retired plan `sweepEodRows`) — reads `ESTIMATED · INTRADAY`;
// ESTIMATED stays the head word. An EOD estimate (not `provisional`) reads plain ESTIMATED.
const estWord = (o) => (o?.provisional === true ? "ESTIMATED · INTRADAY" : "ESTIMATED");

// The virtual estimate sample (hover readout + dot): neutral, no state letter; `fmtVal(v)` formats
// on the value axis it rides. Caller invokes only at i === n-1 when estActive.
function estimateSample(est, n, lo, hi, geo, fmtVal) {
  const ey = yAt(est.value, lo, hi, geo);
  return {
    date: est.date,
    x: xAt(n - 1, n, geo),
    dotY: ey,
    ys: [ey],
    readout: `${est.date} · ${fmtVal(est.value)} · ${estWord(est)} · from ${est.fromDate}`,
    chip: `${compactDate(est.date)} · ${fmtVal(est.value)} est`,
  };
}

// Dashed-neutral estimate segment + end marker + label, and its legend clause. Both "" when
// inactive or the anchor close is missing ⇒ byte-identical svg. Never toned by a cut, never in the ribbon.
function estimateOverlay(est, estActive, values, n, lo, hi, geo) {
  if (!(estActive && n >= 2 && values[n - 2] != null)) return { estSvg: "", estLegend: "" };
  const x0 = xAt(n - 2, n, geo);
  const y0 = yAt(values[n - 2], lo, hi, geo);
  const x1 = xAt(n - 1, n, geo);
  const y1 = yAt(est.value, lo, hi, geo);
  const ly = Math.min(Math.max(y1 - 8, geo.mt + 10), geo.mt + plotH(geo) - 2);
  const estSvg =
    `<g data-oas-est="${esc(est.fromDate)}">` +
    `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="var(--ink-dim)" stroke-width="1.75" stroke-dasharray="4 3" />` +
    `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="2.5" fill="var(--ink-dim)" />` +
    `<text class="band-label" x="${(x1 - 5).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" fill="var(--ink-dim)">${estWord(est)} · from ${esc(est.fromDate)}</text>` +
    `</g>`;
  return { estSvg, estLegend: ` · dashed gray = ${estWord(est)} · from ${est.fromDate}` };
}

// INTRADAY label on the last point when /api/series flags it `provisional` (src/intraday.ts).
// Label only — the point draws like any close. "" when inactive ⇒ unchanged svg. An `estimated` tail that
// `estimateState` could not chain (no served `oasEst`) still reads ESTIMATED, never a bare INTRADAY (Defect 2):
// `ESTIMATED · INTRADAY` when also provisional; an EOD-run estimate carries `estimated` alone ⇒ ESTIMATED.
function intradayOverlay(pts, estActive, values, n, lo, hi, geo) {
  const last = pts[pts.length - 1];
  if (estActive || (last?.provisional !== true && last?.estimated !== true) || values[n - 1] == null)
    return { intradaySvg: "", intradayLegend: "" };
  const x = xAt(n - 1, n, geo);
  const y = yAt(values[n - 1], lo, hi, geo);
  const ly = Math.min(Math.max(y - 8, geo.mt + 10), geo.mt + plotH(geo) - 2);
  const [attr, word, by] =
    last.estimated === true ? ["data-estimated", estWord(last), "the final print"] : ["data-intraday", "INTRADAY", "the EOD close"];
  return {
    intradaySvg: `<text class="band-label" ${attr}="${esc(last.date)}" x="${(x - 5).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" fill="var(--ink-dim)">${word} · ${esc(last.date)}</text>`,
    intradayLegend: ` · last point ${word} (${last.date}, replaced by ${by})`,
  };
}

// Hover-readout tail for a stored estimate row (any date — an EOD-estimated id can carry two trailing estimates). "" on a real close.
const estMark = (p) => (p?.estimated === true ? ` · ${estWord(p)}` : "");

// ---------------------------------------------------------------------------
// Spec-driven generic detail renderer (`genericDetailChart`).
//
// Renders a detail chart PURELY from `meta.chart` (the declarative `ChartSpec`
// emitted per id by `api/indicators.ts buildChart`). The three layouts differ
// enough (secondary-axis machinery, effective vs baked bands, three
// legends) that the renderer selects a layout from the SPEC SHAPE — not from
// `meta.id` — then draws each with the series/band data resolved off the spec.
// ---------------------------------------------------------------------------

/**
 * Named compute hooks (spec `ChartSeries.compute`). Each takes a point and
 * returns the derived value (or null when the inputs aren't present yet).
 * `havenEnvelope` = worst-of `max(eur, chf, jpy)` — the exact per-point max the
 * FXH ribbon scores against.
 */
// `probit` = the modelled 12-month recession probability of THIS point's `value`. Live for R8 only,
// where `value` is already the 21-obs mean the model is estimated on — feeding it a daily close would
// paint a probability the model never claimed. Display-only; nothing scores off it.
const COMPUTE_HOOKS = {
  havenEnvelope: (p) => (p.havenLegs ? havenEnvelope(p.havenLegs) : null),
  probit: (p) => recessionProbabilityPct(p.value),
};

/** Trailing-mean window per MA compute hook — mirrors the server's `MA_OVERLAY_WINDOW`
 *  (src/chart-rail.ts: PRICE_WINDOWS.maShort / MA_WINDOW); the browser cannot import the TS
 *  constant, so `detail-chart.test.js` parity-pins this copy against it. */
export const MA_WINDOWS = { ma50: 50, ma200: 200 };
/** Trailing-MAX window per high hook — mirrors `MA_OVERLAY_WINDOW.high60` (the descriptor's `highWindow`), same pin. */
export const HIGH_WINDOWS = { high60: 60 };

/** `rv10` / `rv20` hook windows — mirror `RV10_WINDOW` / `RV20_WINDOW` (src/chart-rail.ts), parity-pinned in `rv-panel.test.js`. */
export const RV_PANEL = { rvWindow: 10, rvSlowWindow: 20 };
/** `/value` veto constants (XDEV's veto dots) — mirrors `XDEV_GATE_DESCRIPTOR.scorer.constants`, same pin. */
export const VETO_PANEL = { vetoSd: 3, vetoWindow: 5, sigmaWindow: 60 };

/** A realized-vol `fit` line — an annualised FRACTION, sharing one fitted scale with its siblings. */
const isRvHook = (s) => s.compute === "rv10" || s.compute === "rv20";
/** Annualised sample sd (n−1) of the `n` log returns ending at i — `realizedVol` (scripts/probe-eufin-tranches.ts). */
const realizedVolAt = (vals, i, n) => ((sd) => (sd == null ? null : sd * Math.sqrt(252)))(logRetSdAt(vals, i, n));
/** Sample sd (n−1) of the `n` log returns ending at i, newest first (= the probe's `sd` order);
 *  null short of n+1 closes or across a null/non-positive close (a log of it would paint NaN). */
function logRetSdAt(vals, i, n) {
  if (i < n || n < 2) return null;
  const r = [];
  for (let k = 0; k < n; k++) {
    const a = vals[i - k];
    const b = vals[i - k - 1];
    if (!(a > 0) || !(b > 0)) return null;
    r.push(Math.log(a / b));
  }
  const m = r.reduce((x, y) => x + y, 0) / n;
  return Math.sqrt(r.reduce((acc, x) => acc + (x - m) ** 2, 0) / (n - 1));
}

/** Finite `value` per point, else null — the close vector the vol/veto hooks read. */
const closesOf = (pts) => pts.map((p) => (typeof p?.value === "number" && Number.isFinite(p.value) ? p.value : null));

/** The `/value` veto read (feeds `vetoBreach`), POINT-IN-TIME per day t: logRet = ln(c_t / c_t−1); vetoCap = −vetoSd × the sd of the
 *  `sigmaWindow` log returns ending `vetoWindow` before t — the probe's `noDrop` cap with t as the run date. */
function vetoPanel(pts) {
  const { vetoSd, vetoWindow, sigmaWindow } = VETO_PANEL;
  const vals = closesOf(pts);
  const logRet = vals.map((v, i) => (i >= 1 && v > 0 && vals[i - 1] > 0 ? Math.log(v / vals[i - 1]) : null));
  const vetoCap = vals.map((_v, t) => ((sd) => (sd == null ? null : -(vetoSd * sd)))(logRetSdAt(vals, t - vetoWindow, sigmaWindow)));
  return { logRet, vetoCap };
}

/** Inclusive trailing mean of `value` over `w` obs ending at each index; null until `w` obs are
 *  in the window and across any null inside it. */
function trailingMean(pts, w) {
  return pts.map((_p, i) => {
    if (i < w - 1) return null;
    let sum = 0;
    for (let k = i - w + 1; k <= i; k++) {
      const v = pts[k]?.value;
      if (v == null) return null;
      sum += v;
    }
    return sum / w;
  });
}

/**
 * Whole-ARRAY compute hooks (spec `ChartSeries.compute`) — for windowed derives a
 * per-point hook can't express. `roc30` = the 30-day rate-of-change `v[i] − v[i−30]`
 * (null for the first 30 indices and across any null-value gap). Fed the FULL point
 * array (including the `lead` buffer) so the leading window is defined before the
 * caller slices to the visible window. Checked BEFORE the per-point `COMPUTE_HOOKS`.
 */
export const SERIES_HOOKS = {
  roc30: (pts) => pts.map((p, i) => (i >= 30 && p.value != null && pts[i - 30]?.value != null ? p.value - pts[i - 30].value : null)),
  // `ma50`/`ma200` = the trailing `MA_WINDOWS[hook]`-obs mean of `value` (one helper,
  // `trailingMean`). `ma200` is the SAME MA the belowMA gates score against (scorers-price.ts MA_WINDOW),
  // so on F8/F4 the drawn line is the gate's own line; `ma50` is display-only (EXSH_GATE). Null
  // until the window is full and across any null in it (an incomplete mean would read as a real
  // level). Needs the spec's `lead` (≥ the longest drawn window) to be defined at the left edge.
  ma50: (pts) => trailingMean(pts, MA_WINDOWS.ma50),
  ma200: (pts) => trailingMean(pts, MA_WINDOWS.ma200),
  // Max of the last `HIGH_WINDOWS.high60` closes INCLUDING i (= `offHigh`'s base, src/ladder-jobs.ts);
  // null until the window is full and across any null in it, like `trailingMean`.
  high60: (pts) => {
    const w = HIGH_WINDOWS.high60;
    return pts.map((_p, i) => {
      if (i < w - 1) return null;
      let max = -Infinity;
      for (let k = i - w + 1; k <= i; k++) {
        const v = pts[k]?.value;
        if (v == null) return null;
        if (v > max) max = v;
      }
      return max;
    });
  },
  // The `RV10_OVERLAY` fit line: annualised realized vol of the `rvWindow` log returns ending at i — a FRACTION (0.15 = 15%).
  rv10: (pts) => ((vals) => vals.map((_v, i) => realizedVolAt(vals, i, RV_PANEL.rvWindow)))(closesOf(pts)),
  // EU-Fin EXSH's RV20 (`TOGGLE_OVERLAYS.LEGP_EUFIN`) — the same measure over `rvSlowWindow` returns.
  rv20: (pts) => ((vals) => vals.map((_v, i) => realizedVolAt(vals, i, RV_PANEL.rvSlowWindow)))(closesOf(pts)),
  // The close on every day the veto panel's log return sits UNDER its −σ cap (strict, = the probe's `noDrop`
  // failing), else null — Value XDEV's toggled veto dots (`TOGGLE_OVERLAYS`). Display-only.
  vetoBreach: (pts) => {
    const { logRet, vetoCap } = vetoPanel(pts);
    return pts.map((p, i) => (logRet[i] != null && vetoCap[i] != null && logRet[i] < vetoCap[i] ? p.value : null));
  },
  // `lowRise` = the rise from the trailing MINIMUM over `s.window` obs (v[i] − min(window ending at
  // i)), the SAME level-unit decision variable `derivedValue` computes server-side (scorers-core.ts)
  // for F1's displayOnly credit leg. Inclusive window ending at i (needs window−1 prior obs, matching
  // that file's convention): null for the first window−1 indices and across any null in the window (an
  // incomplete min would read as a real floor). The window rides the SERIES (`ChartSeries.window` =
  // F1_LOW_RISE_WINDOW), so 90 is never restated here; an absent/invalid window ⇒ all-gap.
  // `trailingReturn` = `v[i]/v[i−s.window] − 1` over the plotted `value` — the SAME expression
  // `trailingReturnAt` (src/scorers-core.ts) computes server-side, including its base guard
  // (non-positive/non-finite base ⇒ gap, never a fabricated 0). Live for F13's d20 leg, whose
  // `value` IS the HYG÷LQD ratio the scorer reads, so the drawn line is the scored leg itself.
  // ⚠ NOT `p.delta20`: that is the stored level DIFFERENCE over the same span, a different number.
  // The window rides the SERIES (`ChartSeries.window`), so it is never restated here; an
  // absent/invalid window ⇒ all-gap. Needs `window` prior points to be warm at the visible edge —
  // on F13 the client's date-anchor PAD supplies them (`DETAIL_FROM_PAD_DAYS`, app.js).
  trailingReturn: (pts, s) => {
    const w = s?.window;
    if (!(typeof w === "number" && w >= 1)) return pts.map(() => null);
    return pts.map((p, i) => {
      if (i < w || p.value == null) return null;
      const base = pts[i - w]?.value;
      return typeof base === "number" && base > 0 && Number.isFinite(base) ? p.value / base - 1 : null;
    });
  },
  // `delta` = `v[i] − v[i−s.window]`, the level difference (the display-only Δ5 line, `DELTA5_OVERLAY`
  // in chart-rail.ts) — `roc30`'s expression with the window off the SERIES. Null across a gap / before warm.
  delta: (pts, s) => {
    const w = s?.window;
    if (!(typeof w === "number" && w >= 1)) return pts.map(() => null);
    return pts.map((p, i) => (i >= w && p.value != null && pts[i - w]?.value != null ? p.value - pts[i - w].value : null));
  },
  // `offHigh` = `v[i] / max(v over the inclusive `s.window` closes ending at i) − 1` — `offHigh` in
  // src/ladder-jobs.ts (spit's yen gate, F17's display-only secondary line). Null before warm / across a gap.
  offHigh: (pts, s) => {
    const w = s?.window;
    if (!(typeof w === "number" && w >= 1)) return pts.map(() => null);
    return pts.map((p, i) => {
      if (i < w - 1 || p.value == null) return null;
      let hi = -Infinity;
      for (let k = i - w + 1; k <= i; k++) {
        const v = pts[k]?.value;
        if (v == null) return null;
        if (v > hi) hi = v;
      }
      return hi > 0 ? p.value / hi - 1 : null;
    });
  },
  // `median` = the median of `value` over the inclusive `s.window` closes ending at i (even ⇒ mean of the two
  // middles, = `median` in scripts/ladder-shock.ts). Null before warm / across a gap; absent window ⇒ all-gap.
  median: (pts, s) => {
    const w = s?.window;
    if (!(typeof w === "number" && w >= 1)) return pts.map(() => null);
    return pts.map((_p, i) => {
      if (i < w - 1) return null;
      const win = [];
      for (let k = i - w + 1; k <= i; k++) {
        const v = pts[k]?.value;
        if (v == null) return null;
        win.push(v);
      }
      win.sort((a, b) => a - b);
      return w % 2 ? win[(w - 1) / 2] : (win[w / 2 - 1] + win[w / 2]) / 2;
    });
  },
  lowRise: (pts, s) => {
    const w = s?.window;
    if (!(typeof w === "number" && w >= 1)) return pts.map(() => null);
    return pts.map((p, i) => {
      if (i < w - 1 || p.value == null) return null;
      let min = Infinity;
      for (let k = i - w + 1; k <= i; k++) {
        const v = pts[k]?.value;
        if (v == null) return null;
        if (v < min) min = v;
      }
      return p.value - min;
    });
  },
};

/** Legend/readout name per primary-overlay compute hook — the fallback when the spec's
 *  series carries no `label` of its own (F8's overlay ships one: its MA200 is drawn at the
 *  gate's +10% headroom, so the generic "200-day MA" would mislabel the line). */
const TREND_LABEL = {
  ma50: `${MA_WINDOWS.ma50}-day MA`,
  ma200: `${MA_WINDOWS.ma200}-day MA`,
  high60: `${HIGH_WINDOWS.high60}-close high`,
};
/** Trend-overlay stroke per `ChartSeries.tone` (absent ⇒ `--trend-line`, every pre-tone user) and the
 *  colour word the legend names it by when MORE than one trend line shares the axis. `trend` is the
 *  default hue named explicitly — what a toned DECISION line (default `--ink-dim`) opts into. */
const TREND_TONES = {
  default: { stroke: "var(--trend-line)", word: "blue" },
  trend: { stroke: "var(--trend-line)", word: "blue" },
  alt: { stroke: "var(--trend-line-2)", word: "orange" },
  white: { stroke: "var(--trend-line-white)", word: "white" },
  cyan: { stroke: "var(--trend-line-cyan)", word: "cyan" },
};
const trendTone = (s) => TREND_TONES[s?.tone] ?? TREND_TONES.default;
/** A trend series' legend name: server-supplied `label` first, then the per-hook default. */
const trendLabel = (s) => s?.label ?? TREND_LABEL[s?.compute] ?? "trend";
/** Crosshair-chip tail for the plain MA overlays (unlabelled `ma50`/`ma200` hooks — AT1, EXSH_GATE,
 *  F4): `MA200 1.23`, compact because the chip is ONE SVG `<text>`. A labelled trend (F8's scaled MA,
 *  a rolling peak) stays readout-only — its meaning does not fit a tag. Null when none is defined. */
function chipTrendTail(trends, trendSpecs, i, unit) {
  const terms = trends
    .map((a, ti) => {
      const s = trendSpecs[ti];
      const w = MA_WINDOWS[s?.compute];
      return w != null && s.label == null && a[i] != null ? `MA${w} ${formatValue(a[i], unit)}` : null;
    })
    .filter(Boolean);
  return terms.length ? terms.join(" · ") : null;
}

/** A series' HOVER-READOUT name: `trendLabel`'s legend name cut at its first " — " clause, since a
 *  legend label may carry an explanatory tail the one-line readout has no room for (DB_*'s
 *  "SMH 50-day MA (as drawdown) — below it, the gate is on" reads out as the lead clause alone).
 *  A label with no such tail is returned unchanged. */
const readoutName = (s) => trendLabel(s).split(" - ")[0];

/**
 * First index of the visible window. DATE-anchored (`fromDate` set — the aligned-start ids):
 * the first point whose date ≥ the anchor, so charts sampled differently all begin on one
 * calendar date; a windowed compute (F1's roc30) is still evaluated over the FULL `allPts`
 * before this slice, so the pre-anchor points warm it without being drawn. Clamps to 0 when
 * the whole series predates the anchor (a lagging feed degrades to its full history, never
 * empty). COUNT-anchored (no `fromDate`): the trailing `countWindow` points, as before.
 * `userWindow` (the zoneD.window chip) tightens either mode to `min(userWindow, countWindow)`
 * trailing points — date-anchored: `max(anchor, len - window)`; null = unchanged. A chip WIDER than
 * DETAIL_LIMIT (`5y`) instead EXPANDS: date-anchored ⇒ the anchor alone (fetchDetailSeries already
 * moved it back to the chip's span, keeping aligned ids on one start); count ⇒ its trailing count.
 */
function windowStartIndex(allPts, fromDate, countWindow, userWindow = null) {
  const expands = userWindow != null && userWindow > DETAIL_LIMIT;
  if (expands && !fromDate) return Math.max(0, allPts.length - Math.max(userWindow, countWindow));
  const count = userWindow == null ? countWindow : Math.min(userWindow, countWindow);
  if (fromDate) {
    const i = allPts.findIndex((p) => p.date >= fromDate);
    const anchor = i < 0 ? 0 : i;
    return userWindow == null || expands ? anchor : Math.max(anchor, Math.max(0, allPts.length - count));
  }
  return Math.max(0, allPts.length - count);
}

/** Visible start for `spec` under its host renderer — fx: full length · derived: DETAIL_LIMIT (ignores `window`) ·
 *  single: `window ?? DETAIL_LIMIT`. The ONE cut the host renderers and `ribbonOnlyChart` share. */
function specWindowStart(allPts, spec, userWindow = spec.userWindow ?? null) {
  const kind = rendererKind(spec);
  const count = kind === "fx" ? allPts.length : kind === "derived" ? DETAIL_LIMIT : (spec.window ?? DETAIL_LIMIT);
  return windowStartIndex(allPts, spec.fromDate, count, userWindow);
}

/** Resolve a `ChartSeries.fromPoint` path against one point (null = line gap).
 *
 * ⚠ CLOSED if/else, `null` otherwise — a spec naming a field with no arm here draws an EMPTY
 * line at every point, silently and with a green typecheck (`fromPoint` is a plain `string` on
 * `ChartSeries`). Adding a wire field the spec plots therefore owes an arm here — `cusum` (F9's
 * S⁺ accumulator) and `velZ` (BONOS's velocity z on the secondary axis) are two such arms. `?? null`
 * throughout, never `?? 0`: a missing reading must GAP, and a 0 is a real value here (`cusum` 0 =
 * "drift decayed", `velZ` 0 = "at the σ mean"). The census in `detail-chart.test.js` pins every arm. */
export function pointField(p, path) {
  if (path === "value") return p.value ?? null;
  if (path === "delta20") return p.delta20 ?? null;
  if (path === "decision") return p.decision ?? null;
  if (path === "cusum") return p.cusum ?? null;
  if (path === "velZ") return p.velZ ?? null;
  // R1's short-leg gate line. `?? null` is load-bearing here too: a 0 is a real reading ("the short
  // leg is exactly flat"), while a MISSING key means no aligned short obs ⇒ the gate is off, which
  // a drawn 0 would misrepresent as "on the wrong side of both bounds by a hair".
  if (path === "shortMove") return p.shortMove ?? null;
  if (path === "rollingMax") return p.rollingMax ?? null;
  if (path === "gateLine") return p.gateLine ?? null;
  // DISP's rolling-p90 correlation deepener line. `?? null` gaps the warm-up head (absent key ⇒ NaN
  // percentile), never drawing a spurious low cut at 0.
  if (path === "corrP90") return p.corrP90 ?? null;
  // R1's redWindow mean (the drawn scored-mean line). `?? null` breaks the pre-window head into a
  // gap rather than drawing it at 0.
  if (path === "redMean") return p.redMean ?? null;
  if (path.startsWith("havenLegs.")) return p.havenLegs?.[path.slice("havenLegs.".length)] ?? null;

  if (path.startsWith("bullLegs.")) return p.bullLegs?.[path.slice("bullLegs.".length)] ?? null;
  return null;
}

/** A `ChartSeries` → per-point value array (via `compute` hook or `fromPoint`), scaled by
 *  the spec's optional `scale` (absent ⇒ 1) — F8 draws its MA200 at the gate's ×1.1 line. */
function seriesValues(s, pts) {
  const raw = (() => {
    if (s.compute) {
      const arrayHook = SERIES_HOOKS[s.compute];
      if (arrayHook) return arrayHook(pts, s);
      const hook = COMPUTE_HOOKS[s.compute];
      // A hook this build lacks (cached JS vs a newer API) GAPS the line, never throws the stack.
      return pts.map((p) => (hook ? hook(p) : null));
    }
    return pts.map((p) => pointField(p, s.fromPoint));
  })();
  return s.scale == null || s.scale === 1 ? raw : raw.map((v) => (v == null ? null : v * s.scale));
}

// ---------------------------------------------------------------------------
// Case 5 — make a confirmation lag visible. A point whose raw threshold state
// (`rawState`, on the wire since api/series.ts) differs from its confirmed
// `state` breached without confirming on that close. Such cells get a diagonal
// hatch in the RAW state's color OVER the confirmed-state fill — "amber
// breached, unconfirmed" reads as amber-hatch on green, a buffer, not a bug.
//
// ⚠ Still required: live stand-down closes diverge again (directional fold 2026-08-26 — raw
// improved, confirmed held worse for 2 closes), and `api/series.ts` serves stored pre-IS-5
// divergence verbatim too. The copy describes the row's own close, not a live buffer depth.
// ---------------------------------------------------------------------------

/** Inline diagonal-hatch pattern defs, one per state color (url(#pend-STATE)).
 *  Emitted into the svg only when the window actually has a pending cell. */
const PENDING_DEFS = `<defs>${Object.entries(STATE_COLORS)
  .map(
    ([s, color]) =>
      `<pattern id="pend-${s}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="2.5" height="6" fill="${color}" /></pattern>`,
  )
  .join("")}</defs>`;

/** Unconfirmed cell: raw ≠ confirmed state (known states only). Reachable on live stand-down
 *  closes (directional fold, 2026-08-26) and on pre-IS-5 stored rows — see the Case-5 header. */
const isPending = (p) => p.rawState != null && p.rawState !== p.state && STATE_COLORS[p.rawState] != null;

/** Width of the left-edge state stripe. DERIVED, not eyeballed: a stacked frame's chart-name glyph
 *  band opens at `STACK_NAME_X - NAME_BAND_L` (=4) and every pair of margin lanes keeps `LANE_GAP`,
 *  so this is exactly the slack already unused at x=0 — no lane moves and `ml` is unchanged, on the
 *  stacked frame and on CH alike. Widening the stripe means adding a real lane to that model
 *  (shifting `STACK_AXIS_X`/`ml`), never raising this constant past the gap. */
export const SIDEBAR_W = STACK_NAME_X - NAME_BAND_L - LANE_GAP;

/** The edge state stripes: the NEWEST ribbon cell's fill repeated down the plot band at BOTH frame
 *  edges (x=0 and `w - SIDEBAR_W`, 2026-09-30 — the right twin so a phone pinch-zoomed into the
 *  right half still reads the colour), so a stacked chart's current colour reads at a glance without
 *  hunting the ribbon's right end. It MIRRORS the ribbon rather than re-deriving state — same
 *  `fillFor` override, same pending hatch, same title — so the two can never disagree about the
 *  latest close. The hatch patterns are the ribbon's own `defs`: same `<svg>`, and
 *  `pts.some(isPending)` necessarily covers the newest point. The right twin sits flush at the
 *  frame edge, NOT in a modelled lane: on a dual-axis chart it shares ~1 unit with the secondary
 *  axis name's glyph band (`w - 3`, band to `w - 1`) — accepted over widening `mr` on every chart. */
function stateSidebar(pts, fillFor, geo) {
  const p = pts[pts.length - 1];
  if (!p) return "";
  const fill = (fillFor && fillFor(p)) || STATE_COLORS[p.state] || "var(--ink-dim)";
  const h = plotH(geo).toFixed(2);
  const pending = isPending(p);
  const pendText = pending ? ` (raw ${p.rawState}, unconfirmed on this close)` : "";
  const title = `<title>${esc(p.date)} ${esc(p.state)}${esc(pendText)}</title>`;
  const stripe = (x) => {
    const hatch = pending
      ? `<rect x="${x}" y="${geo.mt}" width="${SIDEBAR_W}" height="${h}" fill="url(#pend-${p.rawState})" pointer-events="none" />`
      : "";
    return `<rect data-state-sidebar="${esc(p.state)}" x="${x}" y="${geo.mt}" width="${SIDEBAR_W}" height="${h}"
    fill="${fill}">${title}</rect>${hatch}`;
  };
  return stripe(0) + stripe(geo.w - SIDEBAR_W);
}

/**
 * The state ribbon under the plot: one cell per point, confirmed-state fill,
 * hatched with the raw state's color while confirmation is pending. Shared by
 * all layouts; `extraTitle(p)` appends layout-specific tooltip text (esc'd here).
 * Prepends the hatch pattern defs only when some cell needs them, so a window
 * with no divergence renders byte-identically to the pre-Case-5 ribbon.
 * Also emits the left-edge state stripe (`stateSidebar`).
 */
function stateRibbon(pts, extraTitle = () => "", fillFor = null, geo = CH) {
  const n = pts.length;
  const ribTop = ribbonTop(geo);
  const cellW = plotW(geo) / n;
  const cells = pts
    .map((p, i) => {
      const x = (geo.ml + i * cellW).toFixed(2);
      const pending = isPending(p);
      const pendText = pending ? ` (raw ${p.rawState}, unconfirmed on this close)` : "";
      const hatch = pending
        ? `<rect x="${x}" y="${ribTop}" width="${Math.ceil(cellW) + 0.5}" height="${RIBBON_H}" fill="url(#pend-${p.rawState})" pointer-events="none" />`
        : "";
      // `fillFor` (value-only gray, or F7's value-vs-mean severity) overrides the confirmed-state
      // colour; absent ⇒ the normal STATE_COLORS[state] fill, byte-identical to before.
      const fill = (fillFor && fillFor(p)) || STATE_COLORS[p.state] || "var(--ink-dim)";
      return `<rect x="${x}" y="${ribTop}" width="${Math.ceil(cellW) + 0.5}" height="${RIBBON_H}"
        fill="${fill}"><title>${esc(p.date)} ${esc(p.state)}${esc(pendText)}${esc(extraTitle(p))}</title></rect>${hatch}`;
    })
    .join("");
  return (pts.some(isPending) ? PENDING_DEFS : "") + stateSidebar(pts, fillFor, geo) + cells;
}

/**
 * Legend clause naming the scorer behind the state ribbon. Both halves are SERVED, never restated
 * here: `scorerLegs` is `activeLegs(indicator, cuts)` (the OR-legs whose bounds the cell actually
 * resolved) and `confirmCloses` is `confirmClosesFor(id)`. Hardcoding either rots — the copy read
 * "level/velocity + EVT + regime-z" for months after F1's EVT level pair was retired. A payload
 * without `scorerLegs` (the FXH branch) degrades to the unqualified phrase; `confirmCloses: 0`
 * (the same-day families) reads as same-day rather than "over 0 closes".
 */
/** Served legs, level-axis first then `vel-` (partitioned on the prefix — no second list to
 *  keep in sync with LEG_ORDER). */
const orderedLegs = (served) => [...served.filter((l) => !l.startsWith("vel-")), ...served.filter((l) => l.startsWith("vel-"))];

function scorerLegend(eff) {
  // The #6 clause strips a trailing " cut" from each leg phrase ONLY here ("scored on level +
  // velocity"); the bounds clause (`cutGuide`) keeps the full phrase.
  const legs = orderedLegs(eff?.scorerLegs ?? []).map((l) => legPhrase(l).replace(/ cut$/, ""));
  const n = eff?.confirmCloses;
  const confirm = n == null ? "" : n === 0 ? "same-day" : `${n}-close confirm`;
  const parts = [];
  if (legs.length) parts.push(`scored on ${esc(legs.join(" + "))}`);
  if (confirm) parts.push(confirm);
  return parts.join(" · ");
}

/**
 * Suffix to `scorerLegend` — which of the named legs' cuts the reader can actually FIND on this
 * frame, and where the rest sit. Composed from the SERVED per-leg bounds (`eff.legBounds`, keyed
 * like `scorerLegs`) matched against the cut values that have an image on the axis each leg scores
 * on — never from a literal leg list or a restated cut (either would rot the moment `scorerLegs`
 * or a cut changes). `levelAxis`/`velAxis` are `{ fmt, lo, hi, imaged }`: `imaged` = every cut
 * value that axis draws (a static band, a moving cut's newest value — in-frame line or ▼/▲ edge
 * marker); an axis without `lo`/`hi` in scope formats with the fallback `fmt`, carries no
 * above/below-plot note and images nothing.
 *
 * A leg whose every served bound has an image is DRAWN ("dashed lines = …"); any other leg is
 * listed under "not drawn:" so its numbers are never mistaken for the lines on screen. The
 * above/below-plot note rides the VALUE it describes, in either group — so "red 0.8494 (above
 * plot)" can no longer sit beside an in-frame red line belonging to a different leg (R2, whose
 * `vel-op` pair is drawn while its EVT/z pairs are not, read exactly that way until 2026-09-13).
 * With no bounds served the guide degrades to a line-count sentence.
 */
function cutGuide(eff, levelAxis, velAxis) {
  const bounds = eff?.legBounds;
  const legs = bounds
    ? orderedLegs(eff?.scorerLegs ?? []).filter((l) => bounds[l] != null && (bounds[l].amber != null || bounds[l].red != null))
    : [];
  if (!legs.length) {
    const anyLine = [levelAxis, velAxis].some((ax) => ax?.imaged?.some((v) => inFrame(ax, v)));
    return anyLine ? " · dashed lines = the exact cuts it scores against" : " · no cut line is in frame on this axis";
  }
  const drawn = [];
  const undrawn = [];
  for (const l of legs) {
    const b = bounds[l];
    const ax = (l.startsWith("vel-") ? velAxis : levelAxis) ?? levelAxis ?? velAxis;
    const vals = [
      ["amber", b.amber],
      ["red", b.red],
    ].filter(([, v]) => v != null);
    const isDrawn = vals.every(([, v]) => hasImage(ax, v));
    const note = (v) => {
      if (inFrame(ax, v)) return !isDrawn && hasImage(ax, v) ? " (dashed)" : "";
      return v < ax.lo ? " (below plot)" : " (above plot)";
    };
    const clause = `${legPhrase(l)} ${vals.map(([k, v]) => `${k} ${ax.fmt(v)}${note(v)}`).join(" / ")}`;
    (isDrawn ? drawn : undrawn).push(clause);
  }
  const parts = [];
  if (drawn.length) parts.push(`dashed lines = ${drawn.join(" · ")}`);
  if (undrawn.length) parts.push(`not drawn: ${undrawn.join(" · ")}`);
  return ` · ${esc(parts.join(" · "))}`;
}

/** Whether `v` lies inside an axis's plotted range; an axis without `lo`/`hi` in scope is
 *  treated as in-frame (nothing to be above or below). */
const inFrame = (ax, v) => ax?.lo == null || ax?.hi == null || (v >= ax.lo && v <= ax.hi);

/** Whether an axis draws a cut at `v` (line or edge marker). Tolerant to float noise between a
 *  served bound and the same cut's plotted value (both derive from one resolver, never restated). */
const hasImage = (ax, v) => (ax?.imaged ?? []).some((d) => Math.abs(d - v) <= 1e-9 + 1e-6 * Math.abs(v));

// ---------------------------------------------------------------------------
// Case 4 — gate-aware decision line. A compound-rule indicator (spec `gates` +
// `gatedBy` on its decision series; per-point `gates` flags on the wire) has
// AND-conditions the plotted line can't show. The renderer dims/dashes the
// series' segments where NO listed gate is on — a band cross there cannot fire
// — so a non-firing crossing reads as designed. Keyed off the CONTRACT, never
// off indicator ids.
// ---------------------------------------------------------------------------

/**
 * Whether the gates are "on" (armed) at one point: any listed gate flag true.
 * Fail-safe degrade: dim ONLY when EVERY listed key is present and false. Any
 * missing key — no `gatedBy` on the series, no `gates` on the point (old
 * payload / shallow store), or a partially-resolved point (one flag emitted,
 * another's window uncovered) — is unknown and potentially on ⇒ true (draw
 * normally). Unknown must never grey the line.
 */
function gateOnAt(p, gatedBy) {
  if (!gatedBy || gatedBy.length === 0) return true;
  const present = gatedBy.filter((k) => p.gates && typeof p.gates[k] === "boolean");
  if (present.length < gatedBy.length) return true; // any listed flag missing ⇒ potentially on
  return present.some((k) => p.gates[k] === true);
}

/**
 * Legend copy for a gated spec: which band(s) each gate arms, plus (only when the
 * window has a gate-off day) what that means. `dims` says whether THIS renderer
 * actually draws gate-off runs dim/dashed — `genericDerived` draws its decision line
 * uniformly (since an earlier commit), so there the clause points at the hover readout instead of
 * describing a mark the chart does not draw.
 */
function gateLegend(spec, anyOff, dims) {
  const gates = spec.gates;
  if (!gates || gates.length === 0) return "";
  const req = gates
    .map((g) => `${g.appliesTo === "both" ? "amber/red" : g.appliesTo} also requires ${g.label}`)
    .join("; ");
  if (!anyOff) return ` · ${req}`;
  const where = dims ? "dim/dashed where no gate is active" : "hover reads “gate off” where no gate is active";
  return ` · ${req} — ${where} (a band cross cannot fire)`;
}

/**
 * One band cut → SVG against a DATA-anchored padded [lo,hi] frame (D0-a: bands
 * no longer fold into the y-domain, so a moving cut moves on screen instead of
 * dragging the frame with it). In range: the dashed cut line + label, as before.
 * Off range: NO full line (a flat edge line would fake a threshold sitting at
 * the boundary) — a small ▼/▲ marker at the plot edge, the label carrying the
 * true value. `edgeSeen` is a per-chart {below, above} counter the caller shares
 * across its cuts so two markers on the same edge stack instead of overprinting; it
 * also accrues `labelYs`, the in-range label positions already placed, so two CLOSE
 * cuts (F1's amber/red pair) stagger — a clashing label flips BELOW its
 * line, then keeps stepping down until clear — instead of overprinting.
 */
/** Label y for a cut line at `y`, staggered against the labels already placed on this chart.
 *  Shared by the primary path and `genericSingle`'s secondary cuts so the two can never drift. */
function stackedLabelY(edgeSeen, y) {
  const placed = (edgeSeen.labelYs ??= []);
  const clash = (cand) => placed.some((p) => Math.abs(p - cand) < 10);
  let ly = y - 3; // default: just above the cut line (a lone cut is byte-identical)
  if (clash(ly)) ly = y + 11;
  while (clash(ly)) ly += 11;
  placed.push(ly);
  return ly;
}

// Pair hue map (`ChartSeries.pair`/`ChartBand.pair`, R7 leg↔cut pairing): hue carries LEG
// identity. Unknown/absent pair ⇒ undefined ⇒ callers fall back to today's strokes, byte-identical.
const PAIR_HUES = { drop: "var(--pair-drop)", steep: "var(--pair-steep)" };
// The same two hues as CLASSES (`.dc-pair-*`, styles.css), for HTML markup. PAIR_HUES itself may
// reach only the SVG `stroke=`/`fill=` presentation attributes (`.claude/rules/frontend.md` §Inline style attributes are dead in prod).
const PAIR_HUE_CLASS = { drop: "dc-pair-drop", steep: "dc-pair-steep" };

function bandCutSvg(kind, v, lo, hi, text, edgeSeen = { below: 0, above: 0 }, style = null, geo = CH, hue = null, sink = null) {
  const PW = plotW(geo);
  const PH = plotH(geo);
  const color = hue ?? (kind === "red" ? "var(--state-red)" : "var(--state-amber)");
  // `style:"evt"` — a MEASURED leg's cut drawn beside the operative one (F1). Same severity
  // hue (it is the same severity), distinguished by a DOTTED dash + half-strength line, so the
  // two pairs can never be misread as one cut. Absent ⇒ byte-identical to the pre-batch output.
  // A HUED (paired) cut carries severity on weight/dash (red = heavier + denser, the R7 rule);
  // pair-less cuts keep today's stroke byte-identically.
  // `style:"approach"` (a display-only reference line, a `refSigma` 1σ) takes the same dotted dash, fainter.
  const dash = style === "evt" || style === "approach" ? "1 3" : hue && kind === "red" ? "2 2" : "4 3";
  const faint = style === "evt" ? ' opacity=".6"' : style === "approach" ? ' opacity=".5"' : "";
  const weight = hue ? ` stroke-width="${kind === "red" ? "1.75" : "1.25"}"` : "";
  if (v >= lo && v <= hi) {
    const y = yAt(v, lo, hi, geo);
    // Only the IN-FRAME branch draws a horizontal line, so only it feeds `sink` — the off-plot
    // arm below emits a ▼/▲ marker, not a line the chip could collide with. Same branch, same `y`,
    // so the parking walk's static-band set can never drift from what is drawn (S4).
    sink?.push(y);
    const ly = stackedLabelY(edgeSeen, y);
    return `<line class="band" x1="${geo.ml}" y1="${y.toFixed(1)}" x2="${geo.ml + PW}" y2="${y.toFixed(1)}"
          stroke="${color}" stroke-dasharray="${dash}"${weight}${faint} />
        <text class="band-label" x="${geo.ml + 4}" y="${ly.toFixed(1)}" text-anchor="start" fill="${color}">${esc(text)}</text>`;
  }
  const below = v < lo;
  const slot = below ? edgeSeen.below++ : edgeSeen.above++;
  const y = below ? geo.mt + PH - 3 - slot * 11 : geo.mt + 10 + slot * 11;
  return `<text class="band-marker" x="${geo.ml + 4}" y="${y}" fill="${color}">${below ? "▼" : "▲"}</text>
        <text class="band-label" x="${geo.ml + 16}" y="${y}" text-anchor="start" fill="${color}">${esc(text)}</text>`;
}

/** Layout key of a chart spec — the dispatch `genericDetailChart` routes on and `specWindowStart` cuts by. */
function rendererKind(spec) {
  // Server-stamped layout key wins (`ChartSpec.renderer`, chart-rail.ts — declared per id or
  // derived server-side by this very sniff); the shape-sniff stays the old-payload fallback.
  if (spec.renderer === "fx" || spec.renderer === "derived" || spec.renderer === "single") return spec.renderer;
  const series = spec.series ?? [];
  // FXH shape: primary carries leg/envelope series. Derived shape: a secondary
  // axis fed by the decision series. Everything else is the generic single-axis
  // level/velocity/displayBand/plain layout.
  const isFx = series.some((s) => s.axis === "primary" && (s.style === "leg" || s.style === "envelope"));
  // Derived-kind layout is keyed on a DECISION secondary series (F4/G1/NVDA/F5/F6):
  // its server `decision` line rides the 2nd axis. A non-decision secondary series (a
  // client-computed overlay like F1's `roc30`) falls through to the single-axis layout,
  // keeping the primary threshold cuts + ribbon (Decision 3).
  const hasSecAxis = (spec.axes ?? []).some((a) => a.id === "secondary");
  const isDerived = !isFx && hasSecAxis && series.some((s) => s.axis === "secondary" && s.fromPoint === "decision");
  return isFx ? "fx" : isDerived ? "derived" : "single";
}

/**
 * Spec-driven generic detail chart. Consumes `meta.chart` (axes/series/bands),
 * dispatching on the declared spec shape to one of three layouts — FXH
 * (leg/envelope primary + effective bands + price 2nd axis), derived-kind
 * (value primary + decision 2nd axis + baked bands), or generic level/velocity/
 * displayBand/plain (single axis). Signature MIRRORS `detailChart` so Stage 5
 * can delegate. Returns the same `{ svg, detail }`.
 */
export function genericDetailChart(meta, pts, eff, geo = CH, userWindow = null) {
  let spec = meta.chart;
  // Graceful degrade: a meta WITHOUT `chart` (a stale cached /api/indicators payload
  // predating the spec, or a mock that hasn't mirrored it) must not throw — render a
  // harmless message in the svg slot and an EMPTY pointer-readout seam. Guarded here,
  // at the single entry every caller (detailChart → app.js) funnels through.
  if (!spec) {
    return {
      svg: `<p class="chart-msg">${esc(meta.label ?? meta.id ?? "")} chart spec unavailable - metadata predates the chart API; refresh shortly.</p>`,
      detail: { n: 0, samples: [], staticYs: [] },
    };
  }
  // Case 3 — an unbanded channel declares `bands:"context-only"` (a context/notify-neutral
  // id with no thresholds). Normalize the sentinel to an empty band array so the generic
  // renderers draw the line + ribbon with NO threshold lines and never call `.find`/`.map`
  // on the string. Real bands (an array) pass through untouched.
  if (spec.bands === "context-only") spec = { ...spec, bands: [] };
  // zoneD.window chip: threaded on the spec (beside `spec.window`) so renderer signatures stay put.
  if (userWindow != null) spec = { ...spec, userWindow };
  const primAxis = spec.axes.find((a) => a.id === "primary");
  const secAxisSpec = spec.axes.find((a) => a.id === "secondary");
  const primSeries = spec.series.filter((s) => s.axis === "primary");
  const secSeries = spec.series.filter((s) => s.axis === "secondary");
  const kind = rendererKind(spec);
  if (kind === "fx") return genericFx(meta, pts, eff, spec, primAxis, secAxisSpec, primSeries, secSeries, geo);
  if (kind === "derived") return genericDerived(meta, pts, eff, spec, primAxis, secAxisSpec, primSeries, secSeries, geo);
  return genericSingle(meta, pts, eff, spec, primAxis, primSeries, secAxisSpec, secSeries, geo);
}

/**
 * FXH layout: haven-move (%) primary axis (3 dim leg lines + bold worst-of
 * envelope + effective amber/red cut lines) + EURUSD=X price on a secondary
 * axis. Degrades to a lone price line ("history accruing") when no point
 * carries `havenLegs` (the old-payload fallback).
 */
function genericFx(meta, allPts, eff, spec, primAxis, secAxisSpec, primSeries, secSeries, geo = CH) {
  // zoneD.window chip: DRAW-only trailing slice via the shared windowStartIndex cut. FXH declares
  // no per-id count window, so countWindow = the full length and a null chip keeps today's full
  // draw byte-identical. Every series below (3 haven legs + envelope on the primary axis AND the
  // EURUSD price on ax2) is derived per-point from the sliced `pts`, so both axes slice
  // consistently; FXH has no windowed compute (havenEnvelope is per-point), so nothing needs the
  // pre-slice warmup the derived/single layouts keep.
  const start = specWindowStart(allPts, spec);
  const pts = allPts.slice(start);
  const PW = plotW(geo);
  const n = pts.length;
  const hasLegs = pts.some((p) => p.havenLegs);
  const pUnit = primAxis.unit; // "%" — moves are fractions

  // Graceful degrade: no `havenLegs` → the secondary price series alone, drawn on
  // the PRIMARY axis with a history-accruing note (the old-payload fallback).
  if (!hasLegs) {
    const priceSeries = secSeries.find((s) => s.fromPoint === "value") ?? secSeries[0];
    const values = seriesValues(priceSeries, pts);
    let [lo, hi] = extent(values);
    const padY = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    lo -= padY;
    hi += padY;
    const linePts = values.map((v, i) => [xAt(i, n, geo), yAt(v, lo, hi, geo)]);
    const yTicks = [lo + padY, hi - padY]
      .map((v) => `<text class="axis-y" x="${geo.ml - 8}" y="${(yAt(v, lo, hi, geo) + 3).toFixed(1)}">${esc(formatValue(v, meta.unit))}</text>`)
      .join("");
    const ribbon = stateRibbon(pts, undefined, null, geo);
    const samples = pts.map((p, i) => {
      // Null-primary sample ⇒ dotY = null (no phantom dot on the plot floor, no phantom y in `ys`
      // to poison the parking walk). `yAt(null)` would otherwise land at a finite floor position.
      const dotY = Number.isFinite(values[i]) ? yAt(values[i], lo, hi, geo) : null;
      // Only the lone price line is drawn on this degrade frame, so it is `ys`'s sole contributor.
      const ys = [];
      if (Number.isFinite(dotY)) ys.push(dotY);
      return {
        date: p.date,
        x: xAt(i, n, geo),
        dotY,
        ys,
        readout: `${p.date} · ${formatValue(values[i], meta.unit)} · ${p.state}${estMark(p)}`,
        chip: chipText({ date: p.date, prim: formatValue(values[i], meta.unit), state: p.state }),
      };
    });
    const unitWordF = obsUnitWord(meta);
    const svg = `${chartOpen(chartTitle(meta), geo, chartHead(meta))}
    <path class="line" d="${pathD(linePts)}" fill="none" stroke="var(--ink)" stroke-width="1.75" />
    ${ribbon}${yTicks}${axis1Label(priceSeries?.label ?? "price", geo)}${hoverLayer({ geo, chip: true })}${axisXDates(pts, geo)}
  </svg>
  ${caption(meta, geo, `${primaryAxis(meta, "EURUSD=X price")} · haven-move history accruing · ribbon = state · ${n} ${unitWordF}${n === 1 ? "" : "s"}`)}`;
    // Degrade frame draws no band lines — the static-band set is empty.
    return { svg, detail: { n, samples, staticYs: [] } };
  }

  eff = eff || {};
  // Leg series (in spec order eur/chf/jpy) + the worst-of envelope.
  const legSeries = primSeries.filter((s) => s.style === "leg");
  const legArrs = legSeries.map((s) => seriesValues(s, pts));
  const envSpec = primSeries.find((s) => s.style === "envelope");
  const env = seriesValues(envSpec, pts);

  // PRIMARY (move) domain spans all legs + envelope — DATA only (D0-a): the
  // effective cuts annotate the frame, they never stretch it.
  const bands = [
    ["amber", eff.effAmber],
    ["red", eff.effRed],
  ].filter(([, v]) => v != null);
  const moveVals = [...legArrs.flat(), ...env].filter((v) => v != null);
  let [lo, hi] = extent(moveVals);
  const padY = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  lo -= padY;
  hi += padY;

  const leftPath = (arr) => gapPathFor(arr, n, (v) => yAt(v, lo, hi, geo), geo);

  const edgeSeen = { below: 0, above: 0 };
  // STATIC band y's for the S4 parking walk: the in-frame effective amber/red cuts (the only
  // static lines on this frame; the price 2nd axis carries no bands).
  const staticYs = [];
  const bandSvg = bands
    .map(([kind, v]) => bandCutSvg(kind, v, lo, hi, `${kind} ${formatDerived(v, pUnit)}`, edgeSeen, null, geo, null, staticYs))
    .join("");

  // SECONDARY (price) axis via the reused-as-is secondaryAxis helper, NO bands.
  const priceSpec = secSeries.find((s) => s.fromPoint === "value") ?? secSeries[0];
  const priceVals = seriesValues(priceSpec, pts);
  const ax2 = secondaryAxis({
    series: priceVals,
    bands: [],
    label: secAxisSpec.label,
    unit: secAxisSpec.unit,
    n,
    format: formatValue,
    geo,
  });
  const pricePath = ax2.pathFor(priceVals);

  const yTicks = [lo + padY, hi - padY]
    .map((v) => `<text class="axis-y" x="${geo.ml - 8}" y="${(yAt(v, lo, hi, geo) + 3).toFixed(1)}">${esc(formatDerived(v, pUnit))}</text>`)
    .join("");

  const ribbon = stateRibbon(pts, undefined, null, geo);

  const legLine = (arr) => {
    const d = leftPath(arr);
    return d ? `<path class="line" d="${d}" fill="none" stroke="var(--ink-dim)" stroke-width="1" />` : "";
  };
  const envPath = leftPath(env);

  const unitWord = obsUnitWord(meta);
  const samples = pts.map((p, i) => {
    const L = p.havenLegs;
    const envV = L ? havenEnvelope(L) : null;
    // A point without legs on a chart that HAS legs elsewhere is a feed/store gap on that
    // date, not warmup — "history accruing" stays only for the no-legs-anywhere fallback above.
    const moveText = L
      ? `EUR ${formatDerived(L.eur, "%")} · CHF ${formatDerived(L.chf, "%")} · JPY ${formatDerived(L.jpy, "%")} · worst ${formatDerived(envV, "%")}`
      : "leg gap (feed)";
    // The dot rides the BOLD worst-of line (primary axis) — the number the state is scored off —
    // not the EURUSD price on `ax2` ([USER] 2026-09-04). A leg-gap
    // sample ⇒ dotY = null (no phantom dot / phantom `ys` entry).
    const py = (v) => yAt(v, lo, hi, geo);
    const dotY = Number.isFinite(envV) ? py(envV) : null;
    // Every drawn line's y at this column: the price (on ax2) plus the 3 leg lines + the worst-of
    // envelope on the primary axis — the effective amber/red band cuts are static (S4). The price
    // y stays in `ys` so the hover column still snaps to every drawn line; `pushY` drops a null
    // price (`ax2.scale(null)` would otherwise land at a finite in-frame position).
    const ys = [];
    pushY(ys, p.value, (v) => ax2.scale(v));
    for (const arr of legArrs) pushY(ys, arr[i], py);
    pushY(ys, env[i], py);
    return {
      date: p.date,
      x: xAt(i, n, geo),
      dotY,
      ys,
      readout: `${p.date} · ${moveText} · ${formatValue(p.value, meta.unit)} · ${p.state}${estMark(p)}`,
      // Left axis = the worst-of haven move (the number the state is scored off), right axis =
      // the EURUSD price the dot rides. Both, in axis order.
      chip: chipText({
        date: p.date,
        prim: envV != null ? formatDerived(envV, "%") : null,
        sec: formatValue(p.value, meta.unit),
        state: p.state,
        // The three legs, compact, after the state letter — the chip is ONE SVG `<text>` (no
        // line breaks), so this is a trailing segment, not a second line.
        tail: L ? `EUR ${formatDerived(L.eur, "%")} · CHF ${formatDerived(L.chf, "%")} · JPY ${formatDerived(L.jpy, "%")}` : null,
      }),
    };
  });
  const detail = { n, samples, staticYs };

  const svg = `${chartOpen(chartTitle(meta), geo, chartHead(meta))}
    ${bandSvg}
    ${legArrs.map((a) => legLine(a)).join("")}
    ${envPath ? `<path class="line" d="${envPath}" fill="none" stroke="var(--ink)" stroke-width="2" />` : ""}
    ${pricePath ? `<path class="line-derived" d="${pricePath}" fill="none" stroke="var(--ink-dim)" stroke-width="1.5" stroke-dasharray="3 2" />` : ""}
    ${ribbon}${yTicks}${axis1Label(primAxis?.label ?? "haven move", geo)}${ax2.yTicks2}${ax2.axis2Label}${hoverLayer({ geo, chip: true })}${axisXDates(pts, geo)}
  </svg>
  ${caption(meta, geo, `${primaryAxis(meta, "haven-move, 3 legs + bold worst-of")} · EURUSD=X price (right) · ribbon = state · ${n} ${unitWord}${n === 1 ? "" : "s"}`)}`;
  return { svg, detail };
}

/**
 * The chart's accessible title (`<svg aria-label>`): short name, then the id in parens only when
 * `idIfDistinct` adds info. No id ⇒ no parens; no label ⇒ degrade to the id, never "undefined".
 */
function chartTitle(meta) {
  return `${chartName(meta)} history`;
}

/** Short name + id-in-parens (only when `idIfDistinct` adds info; no label ⇒ the id, never
 *  "undefined" or a stuttered "F1 (F1)") — shared by the accessible title and the head band. */
function chartName(meta) {
  const name = meta.label ?? meta.id ?? "";
  const idSeg = meta.label ? idIfDistinct(meta.label, meta.id) : "";
  return `${name}${idSeg ? ` (${idSeg})` : ""}`;
}

/** The rotated left-margin name for `showHead` (stack) frames; `chartOpen` ignores it on every
 *  other geometry, where the name is already in the caption block above the chart. */
const chartHead = (meta) => ({ name: chartName(meta) });

/** What the indicator MEASURES — the explainer's one-line `tip` (indicator-desc.js), its trailing
 *  period dropped so it reads as a caption clause right after the primary-axis name. Empty for an
 *  id with no explainer entry (leg charts, the never-carded ids). */
const measures = (meta) => {
  const tip = INDICATOR_DESC[meta.id]?.tip;
  return tip ? ` — ${esc(tip.replace(/\.\s*$/, ""))}` : "";
};

/** The PRIMARY-axis clause every caption opens with: `<axis name> (left)` + what it measures. */
const primaryAxis = (meta, name) => `${name} (left)${measures(meta)}`;

/** Caption lead on `showHead` (stack) frames — the chart NAME, so a legend re-slotted below the
 *  stack still says which chart it belongs to — emitted ONLY when the body does not already open
 *  with that label (a label-led primary axis printed it twice, 2026-09-13). No date span any more:
 *  the stack's dates ride the hover readout. Includes the trailing ` · ` so a gated-off head
 *  leaves no dangling separator. */
const captionHead = (meta, geo, body) =>
  geo.showHead && !body.startsWith(esc(meta.label)) ? `${esc(meta.label)} · ` : "";

/** The chart's caption block: stack-only name lead + the body every layout composes. */
const caption = (meta, geo, body) => `<p class="chart-legend">${captionHead(meta, geo, body)}${body}</p>`;

/** The caption's payload clause: short label + unit (`HY OAS, %`), the `, unit` omitted when the
 *  unit is empty — never the literal word "value" (#2). */
const labelUnit = (meta) => `${esc(meta.label)}${meta.unit ? `, ${esc(meta.unit)}` : ""}`;

/** The velocity-mode payload clause: `<label> <span>, <unit>` (`10y Δ20d, pp`, `HYG/LQD Δ20d`) — the
 *  same label-led shape as `labelUnit`, so a Δ chart still says WHAT it is the change of. A label
 *  already ending in "Δ" folds into the span word (mirrors the rail's secondary-axis rule: "10y
 *  Δ20d", never "10y Δ Δ20d"). `metric` arrives escaped (the spec's axis label, or the span-free
 *  fallback). Until 2026-09-13 the clause was the bare span ("Δ20d (left)") — the label prefix it
 *  relied on had moved to the stack-only caption head. */
const velocityLabelUnit = (meta, metric) => {
  const label = esc(meta.label ?? "");
  const joined = !label ? metric : label.endsWith("Δ") && metric.startsWith("Δ") ? `${label}${metric.slice(1)}` : `${label} ${metric}`;
  // A Δ of a %-quoted level (R2/R3's yields) is percentage POINTS — ", %" would read as a relative change.
  const unit = meta.unit === "%" ? "pp" : meta.unit;
  return `${joined}${unit ? `, ${esc(unit)}` : ""}`;
};

/** Bottom x-axis first/last dates; on `showHead` frames they live in the head band instead. */
function axisXDates(pts, geo) {
  if (geo.showHead) return "";
  return `
    <text class="axis-x" x="${geo.ml}" y="${geo.h - 4}" text-anchor="start">${esc(pts[0].date)}</text>
    <text class="axis-x" x="${geo.ml + plotW(geo)}" y="${geo.h - 4}" text-anchor="end">${esc(pts[pts.length - 1].date)}</text>`;
}

/**
 * PER-POINT (MOVING) cuts on one frame — `source:"perPoint"` bands whose value is a per-DATE
 * SERIES read off each point's `bandCuts[fromPoint]`, drawn gap-broken through `pathFor`.
 * The ONE implementation behind genericDerived and genericSingle; they differ only in `fmt` (genericDerived:
 * `formatMagnitude` — a tiny ratio cut like HG÷GC ≈ 0.0019 renders "0.00190", not a false
 * "0.00"; genericSingle: its own tick formatter, so the label agrees with the ticks it sits
 * between) and `drawnSuffix` (" (left, dashed)" vs " (dashed)").
 *
 * TWO deliberate gap sources:
 *  1. a point MISSING the key has NO CUT on that date (the pre-warmup head the server omits)
 *     — drawing 0 there would paint a false band along the bottom of the axis;
 *  2. a cut OUTSIDE the plotted domain is not drawn as a line, because `lo`/`hi` come from the
 *     SERIES alone (D0-a: a band must never drag the y-domain and squash the line it exists to
 *     annotate). It does NOT vanish — the newest off-domain cut gets the same ▼/▲ EDGE MARKER
 *     the scalar-band path emits (`bandCutSvg`) and keeps its legend segment with a
 *     "below/above plot" note, so "no cut computed", "cut off the plotted range" and
 *     "renderer broken" stay distinguishable. The percentiles themselves live in the
 *     descriptors (`POINT_BAND_CUTS_OF` et al.) — never restated here.
 */
function perPointCuts({ spec, pts, axis, lo, hi, pathFor, fmt, drawnSuffix, geo }) {
  const cuts = spec.bands
    .filter((b) => b.source === "perPoint" && (b.axis ?? "primary") === axis)
    .map((b) => {
      let last = null; // newest FINITE cut, in-domain or not — what the legend reports
      const arr = pts.map((p) => {
        const v = p.bandCuts?.[b.fromPoint];
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        last = v;
        return v >= lo && v <= hi ? v : null;
      });
      return { band: b, arr, path: pathFor(arr), last, off: last != null && (last < lo || last > hi) };
    });
  const drawnCuts = cuts.filter((c) => c.path);
  // A PAIRED moving cut takes its LEG's hue, exactly as the secondary-axis cut path does: severity
  // moves to weight/dash (red = heavier + denser) and stays in the label text, while the hue tells
  // two same-severity legs apart. Live for R1, whose two amber lines are different legs — the
  // rung's post-inversion floor (amber) and the regime-relative drawdown cut (`pair:"drop"`, blue).
  // Pair-less bands keep the severity hue and today's stroke, byte-identically.
  const cutSvg = drawnCuts
    .map((c) => {
      const hue = PAIR_HUES[c.band.pair];
      const color = hue ?? (c.band.level === "red" ? "var(--state-red)" : "var(--state-amber)");
      const [width, dash] = hue && c.band.level === "red" ? ["1.75", "2 2"] : ["1.25", "4 3"];
      return `<path class="band-cut" d="${c.path}" fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" />`;
    })
    .join("");
  // Off-domain newest cuts → the shared edge marker. `bandCutSvg`'s own in-range branch cannot
  // fire here (`off` already excluded it), so this only ever emits the ▼/▲ form.
  const cutEdgeSeen = { below: 0, above: 0 };
  const cutEdgeSvg = cuts
    .filter((c) => c.off)
    .map((c) =>
      bandCutSvg(
        c.band.level,
        c.last,
        lo,
        hi,
        `${c.band.label ?? c.band.level} ${fmt(c.last)}`,
        cutEdgeSeen,
        null,
        geo,
        PAIR_HUES[c.band.pair] ?? null,
      ),
    )
    .join("");
  // Every cut with a value keeps its legend segment; an off-domain one says so rather than
  // disappearing.
  const legendCuts = cuts.filter((c) => c.last != null);
  const cutLegend = legendCuts.length
    ? ` · ${legendCuts
        .map(
          (c) =>
            `${c.band.label ?? c.band.level} now ${fmt(c.last)}${c.off ? (c.last < lo ? " (below plot)" : " (above plot)") : ""}`,
        )
        .join(" · ")}${drawnCuts.length ? drawnSuffix : ""}`
    : "";
  // `drawnArrs` = the clamped per-index value array of each DRAWN moving cut (null off-range/missing),
  // so a caller can add each cut's occupied y to a sample's `ys` on the axis it scaled the cut against.
  // `imaged` = the newest value of every cut with an image on this axis (an in-frame line OR a ▼/▲
  // edge marker) — what the cut guide matches a served leg bound against.
  return {
    cutSvg,
    cutEdgeSvg,
    cutLegend,
    drawnCount: drawnCuts.length,
    drawnArrs: drawnCuts.map((c) => c.arr),
    imaged: legendCuts.map((c) => c.last),
  };
}

/** The `toggle` overlays of a PRIMARY [lo, hi] scale, drawn into the shared hidden `.fit-lines` group — one
 *  helper for genericSingle + genericDerived. `edgeSvg(edgeSeen, fmt)` is called AFTER the chart's bands. */
function toggleOverlays(togSeries, togArrs, lo, hi, n, geo) {
  // `toggle` overlays on the PRIMARY scale, never in its domain — so a point outside [lo, hi] GAPS rather than
  // paint into the margin/ribbon. Lines: the trend tone, or a cut's stroke (`s.cut`: severity hue, `approach` =
  // faint dotted like the T1 band) — a `step` style draws a staircase. `dots`: one mark per non-null point.
  const inFrame = (v) => (v != null && v >= lo && v <= hi ? v : null);
  const togStroke = (s) => {
    if (!s.cut) return { stroke: trendTone(s).stroke, dash: "6 3", faint: "", word: trendTone(s).word };
    const stroke = s.cut.level === "red" ? "var(--state-red)" : "var(--state-amber)";
    return s.cut.style === "approach"
      ? { stroke, dash: "1 3", faint: ' opacity=".5"', word: `${s.cut.level} dotted` }
      : { stroke, dash: "4 3", faint: "", word: `${s.cut.level} dashed` };
  };
  const togDrawn = togSeries.map((_s, si) => togArrs[si].some((v) => inFrame(v) != null));
  const togSvg = togArrs
    .map((a, si) => {
      const s = togSeries[si];
      if (!togDrawn[si]) return "";
      const { stroke, dash, faint } = togStroke(s);
      if (s.style === "dots")
        return a
          .map((v, i) => (inFrame(v) == null ? "" : `<circle class="toggle-dot" cx="${xAt(i, n, geo).toFixed(1)}" cy="${yAt(v, lo, hi, geo).toFixed(1)}" r="2.5" fill="${stroke}" />`))
          .join("");
      const d = gapPathFor(a.map(inFrame), n, (v) => yAt(v, lo, hi, geo), geo, s.style === "step");
      return `<path class="line-toggle" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.25" stroke-dasharray="${dash}"${faint} />`;
    })
    .join("");
  // A toggle LINE whose newest value sits outside the frame would otherwise just gap out of sight: its edge side
  // ("below"/"above"), feeding a ▼/▲ edge marker (below, after the bands) and the legend's "(below frame)" note.
  // Dots mark closes, which the data frame always contains. The y-range still never folds a toggle series in.
  const togLast = togArrs.map((a) => a.findLast((v) => v != null) ?? null);
  const togEdge = togSeries.map((s, si) =>
    s.style !== "dots" && togLast[si] != null && inFrame(togLast[si]) == null ? (togLast[si] < lo ? "below" : "above") : null,
  );
  const togShown = togSeries.map((_s, si) => togDrawn[si] || togEdge[si] != null);
  const togTag = (s) => trendLabel(s).split(" (")[0]; // "T3 zone", "veto day", "60-close high"
  // Toggle-overlay edge markers — the band ▼/▲ form (`bandCutSvg`'s off-range arm) in the series' own stroke, the
  // label carrying its newest level. Built AFTER the bands so they take the later `edgeSeen` slots: the visible
  // band markers keep their default-chart positions, and these ride the hidden `.fit-lines` group with the lines.
  const edgeSvg = (edgeSeen, fmt) =>
    togSeries
      .map((s, si) =>
        togEdge[si]
          ? bandCutSvg(s.cut?.level ?? "amber", togLast[si], lo, hi, `${togTag(s)} ${fmt(togLast[si])}`, edgeSeen, null, geo, s.cut ? null : togStroke(s).stroke)
          : "",
      )
      .join("");
  // ONE short `.fit-toggle` key (a one-line phone tap target): cut-stroked lines read "zones", a dot series names its
  // marks ("veto days"); a plain line only names itself when nothing else does. The full per-series roster — stroke
  // word, and "(below frame)" for an edge-marked series — rides the wrapper's `title` (help ⓘ via `setHTML`).
  const togNames = togSeries
    .map((s, si) => {
      if (!togShown[si]) return null;
      const word = s.style === "dots" ? `${s.cut?.level ?? trendTone(s).word} dots` : togStroke(s).word;
      return `${trendLabel(s)} (${word})${togEdge[si] ? ` (${togEdge[si]} frame)` : ""}`;
    })
    .filter(Boolean);
  const shownTog = togSeries.filter((_s, si) => togShown[si]);
  const togKeys = [...new Set(shownTog.map((s) => (s.style === "dots" ? `${togTag(s)}s` : s.cut ? "zones" : null)).filter(Boolean))];
  const togKey = (togKeys.length ? togKeys : shownTog.map(togTag)).join(" · ");
  const togLegend = togNames.length
    ? ` · <span title="${esc(togNames.join(" · "))}"><button class="fit-toggle tog-key" type="button">${esc(togKey)}</button></span>`
    : "";
  return { inFrame, svg: togSvg, edgeSvg, legend: togLegend };
}

/**
 * Derived-kind layout: price/ratio `value` on the primary axis; the server
 * `decision` series + its amber/red bands on a secondary axis (via
 * secondaryAxis). Bands are BAKED in the spec (`source:"derived"`), including the
 * DETAIL_LIMIT trailing-window slice.
 *
 * ⚠ The primary line is NOT always the price: a two-leg id (`SECOND_LEG_CHART_OF`, F13) puts its
 * OTHER SCORED LEG there instead — a client-computed series with its own baked cut pair — so the
 * two legs get two RANGES instead of overlapping on one axis. Hence every primary readout here
 * (ticks, cut labels, hover, legend) formats through the PRIMARY AXIS' own `unit`/`format`, never
 * `meta.unit`: a fraction leg rendered with the price formatter prints "-0.03" for −3.0%.
 */
function genericDerived(meta, allPts, eff, spec, primAxis, secAxisSpec, primSeries, secSeries, geo = CH) {
  const PW = plotW(geo);
  const valueSpec = primSeries.find((s) => s.fromPoint === "value") ?? primSeries[0];
  // S4b: same-day oasEst continuation on the derived route's VALUE line (BRENT/G1). Append the
  // virtual slot BEFORE every seriesValues call so the trailing null flows through the sliced arrays.
  const { est, estActive, pts: estPts } = estimateState(eff, valueSpec, allPts);
  allPts = estPts;
  // Primary-axis formatter/unit/name. An axis with no `format` (every price-line id) keeps
  // `formatValue` + `meta.unit`, byte-identical to before.
  const pUnit = primAxis?.unit ?? meta.unit;
  const pFmt = primAxis?.format === "derived" ? formatDerived : formatValue;
  const pName = primAxis?.format === "derived" ? (primAxis.label ?? valueSpec?.label ?? "") : "price";
  const decisionSpec = secSeries.find((s) => s.fromPoint === "decision") ?? secSeries[0];
  const allValues = seriesValues(valueSpec, allPts);
  const derivedAll = seriesValues(decisionSpec, allPts);
  // Extra PRIMARY series beside the value line — the `ma200` trend overlay on the own-MA-gated ids
  // (F8/F4), and the display-only `ma50`+`ma200` pair on EXSH_GATE (`MA_OVERLAYS`, chart-rail.ts).
  // Computed over the FULL `allPts` (the `lead` buffer) so the longest MA window is already warm at
  // the visible window's left edge, then sliced with it.
  // `toggle` overlays (F8's MA50) ride the hidden `.fit-lines` group (`toggleOverlays`), never the always-drawn trends.
  const togSeries = primSeries.filter((s) => s !== valueSpec && s.toggle && !s.fit);
  const trendSpecs = primSeries.filter((s) => s !== valueSpec && !togSeries.includes(s));
  const trendAll = trendSpecs.map((s) => seriesValues(s, allPts));
  const togAll = togSeries.map((s) => seriesValues(s, allPts));
  // Extra SECONDARY series beside the decision line — a two-leg scorer's other leg
  // (`SECOND_LEG_CHART_OF`, src/family-descriptor-rows.ts; F13's client-computed d20). Computed over the
  // FULL `allPts` so its own lookback is warm at the visible window's left edge, then sliced with it.
  // A one-secondary-series spec (every other derived-route id) leaves this empty ⇒ byte-identical.
  const extraSecSpecs = secSeries.filter((s) => s !== decisionSpec);
  const extraSecAll = extraSecSpecs.map((s) => seriesValues(s, allPts));

  const start = specWindowStart(allPts, spec);
  const pts = allPts.slice(start);
  const values = allValues.slice(start);
  const trends = trendAll.map((a) => a.slice(start));
  const togArrs = togAll.map((a) => a.slice(start));
  const derived = derivedAll.slice(start);
  const extraSec = extraSecAll.map((a) => a.slice(start));
  const n = pts.length;
  // Skip the virtual estimate slot (trailing null) when reading the latest real decision.
  const latest = derivedAll[derivedAll.length - 1 - (estActive ? 1 : 0)];

  // Derived descriptor reconstructed from the spec: axis carries label/unit,
  // the baked bands carry amber/red.
  const dLabel = secAxisSpec.label;
  const dUnit = secAxisSpec.unit;
  // ⚠ AXIS-FILTERED. This lookup feeds the SECONDARY axis' readout, and chart-rail pushes the
  // PRIMARY bands (threshold level pair, perPoint moving cuts) BEFORE the secondary pair —
  // so an unfiltered `find` by level alone returns a primary band on any id carrying both, and
  // the right-axis descriptor silently reads the wrong cut (CG, once its perPoint pair landed).
  // ⚠ EVERY secondary SCALAR cut, not just the first amber/red: a two-leg id carries two pairs on
  // this one axis, and a `find` by level would silently drop the second leg's cut while its LINE was
  // drawn — a leg judged against a cut that is not on the chart. A perPoint band (no `value`) is
  // excluded here and rides `perPointCuts`. Single-pair ids are unaffected: same two bands, same order.
  const secBands = spec.bands.filter((b) => b.axis === "secondary" && typeof b.value === "number");

  // Domain spans the value line AND any primary overlay — an MA200 that runs above the
  // window's price range must stay on-plot, or the "price below its MA" read is invisible.
  // ⚠ NULLS FILTERED OUT of the value line too: a computed primary leg is null until its own
  // lookback is warm, and `extent` compares a null as 0 — one gap would drag the domain to zero.
  // S4b: the estimate endpoint joins the y-domain (its virtual slot's null is filtered out above),
  // so a past-cut estimate is never clipped. Empty when inactive ⇒ byte-identical.
  let [lo, hi] = extent([
    ...values.filter((v) => v != null),
    ...(estActive ? [est.value] : []),
    ...trends.flat().filter((v) => v != null),
  ]);
  const padY = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  lo -= padY;
  hi += padY;
  // Gap-broken primary path (the overlay is null until its window is warm) — and the VALUE line
  // rides it too, since a computed primary leg has the same warm-up gap. On a gapless array
  // `gapPathFor` emits exactly `pathD`'s string, so every price-line id is byte-identical.
  const primaryPathFor = (arr, step = false) => gapPathFor(arr, n, (v) => yAt(v, lo, hi, geo), geo, step);
  const valuePath = primaryPathFor(values);
  // Path + spec kept TOGETHER through the empty-path filter, so each drawn line keeps its own
  // stroke tone and legend name (an index into `trendSpecs` would shift past a dropped path).
  const trendPaths = trends
    .map((a, ti) => ({ d: primaryPathFor(a, trendSpecs[ti].style === "step"), s: trendSpecs[ti] }))
    .filter((t) => t.d);
  const tog = toggleOverlays(togSeries, togArrs, lo, hi, n, geo);

  // PER-POINT (MOVING) primary cuts (CG's expanding-percentile HG÷GC level cuts) — the shared
  // `perPointCuts` helper; its docblock carries the gap/edge-marker rationale. For CG the
  // off-domain case is the COMMON one (the cut sits below the window's values most of the time).
  const { cutSvg, cutEdgeSvg, cutLegend, drawnArrs: primCutArrs } = perPointCuts({
    spec,
    pts,
    axis: "primary",
    lo,
    hi,
    pathFor: primaryPathFor,
    fmt: formatMagnitude,
    drawnSuffix: " (left, dashed)",
    geo,
  });

  // PRIMARY SCALAR level pair (`source:"threshold"`) — an id carrying BOTH a `derived` block and
  // its own level cuts (OVX's OR leg) had them in the spec since R5b but on no pixel: this route
  // drew only perPoint + secondary bands. `eff` (?early=) is not threaded onto this route, so the
  // drawn pair is the registry/vintage cut.
  const lvlT = { ...(meta.thresholds || {}) };
  const lvlSeen = { below: 0, above: 0 };
  const lvlBands = spec.bands
    .filter((b) => b.source === "threshold" && (b.axis ?? "primary") === "primary" && b.metric !== "velocity")
    .map((b) => [b.level, b.level === "amber" ? lvlT.amberLevel : lvlT.redLevel, b.label])
    // A BAKED primary pair — the second leg's own cuts, which travel with a `value` on the spec
    // (`source:"derived"`, axis primary) exactly like the secondary pair. Without this the leg's
    // LINE was on the left axis and the cuts it is judged against were nowhere on the chart.
    .concat(
      spec.bands
        .filter((b) => b.source === "derived" && b.axis === "primary" && typeof b.value === "number")
        .map((b) => [b.level, b.value, b.label]),
    )
    // A BAKED primary displayBand pair — DISP's static DISP_CORR confirm gate, the flat line the
    // moving `corrP90` deepener is read against. Until now this route drew only threshold/derived
    // primary bands, so DISP's gate band sat in the spec (and the golden) but on NO pixel — the axis
    // it lives on carried no line. DISP is the ONLY derived-route id with a primary displayBand band
    // (derivedChart uses threshold/perPoint; downsideChart is single-route), so this restyles no
    // other chart. It stays amber; the deepener line is the blue `trend` hue, so the two never collide.
    .concat(
      spec.bands
        .filter((b) => b.source === "displayBand" && (b.axis ?? "primary") === "primary" && typeof b.value === "number")
        .map((b) => [b.level, b.value, b.label]),
    )
    .filter(([, v]) => v != null);
  // Same D0-a treatment as everywhere else: in-domain draws the line, an unbreached cut above the
  // window becomes a ▲ edge marker carrying its value — never dragging the domain (OVX's price sits
  // well under 45 in a calm regime, and squashing the line would defeat the read).
  // STATIC band y's for the S4 parking walk: the in-frame primary level cuts here, plus the
  // secondary-axis bands pushed once `ax2` exists (below). The MOVING perPoint cuts are per-index
  // and already ride each sample's `ys`, so they are NOT static.
  const staticYs = [];
  const lvlSvg = lvlBands
    .map(([kind, v, label]) =>
      bandCutSvg(kind, v, lo, hi, label ?? `${kind} ${pFmt(v, pUnit)}`, lvlSeen, null, geo, null, staticYs),
    )
    .join("");
  const togEdgeSvg = tog.edgeSvg(lvlSeen, (v) => pFmt(v, pUnit));
  const fitGroup = tog.svg || togEdgeSvg ? `<g class="fit-lines">${tog.svg}${togEdgeSvg}</g>` : "";
  const lvlLegend = lvlBands.length
    ? ` · level ${lvlBands.map(([kind, v, label]) => label ?? `${kind} ${pFmt(v, pUnit)}`).join(" · ")}`
    : "";

  const ax2 = secondaryAxis({
    // Domain = the UNION of every secondary line, so a second leg with its own magnitude
    // (F13's d20 runs wider than its ms50) is never drawn off-plot.
    series: [...derived, ...extraSec.flat()],
    // 3rd element = the spec's custom band label, which WINS over secondaryAxis' auto
    // "<kind> <value>". Threading it is what makes DISP's "red <−2.5% · corr>0.75"
    // reach a pixel — before this it was declared in api/indicators.ts and dropped here,
    // so the chart printed "red 0.0%". Ids whose bands carry no `label` pass undefined
    // and keep the auto-label byte-identical.
    bands: secBands.map((b) => [b.level, b.value, b.label, b.style]), // `style`: `ChartBand.style`'s faint variant
    label: dLabel,
    unit: dUnit,
    n,
    geo,
  });
  staticYs.push(...ax2.bandYs); // the secondary static bands (always in-frame; folded into the domain)
  // Gate state is still computed for the hover "gate off" readout + gateLegend below, but the
  // decision line is drawn ONE uniform strong-dotted style regardless of gate state — the ribbon
  // now carries the correct GREEN/AMBER/RED tiers, so the dim-where-inert overlay is redundant.
  const gatedBy = decisionSpec.gatedBy;
  const on = pts.map((p) => gateOnAt(p, gatedBy));
  const anyOff = on.some((v) => !v);
  const derivedPath = ax2.pathFor(derived);
  // The second leg takes the blue "not a state" trend hue + a longer dash: two --ink-dim dotted
  // lines on one axis are indistinguishable, and the legend below names each.
  const extraSecPaths = extraSec.map((a) => ax2.pathFor(a));
  const extraSecSvg = extraSecPaths
    .filter(Boolean)
    .map(
      (d) =>
        `\n    <path class="line-derived" d="${d}" fill="none" stroke="var(--trend-line)" stroke-width="1.5" stroke-dasharray="6 3" />`,
    )
    .join("");

  const yTicks = [lo + padY, hi - padY]
    .map((v) => `<text class="axis-y" x="${geo.ml - 8}" y="${(yAt(v, lo, hi, geo) + 3).toFixed(1)}">${esc(pFmt(v, pUnit))}</text>`)
    .join("");

  // The estimate slot never enters the ribbon (real closes only — oil-same-day-futures-nowcast plan). A value-only id (KBE) strokes it
  // neutral gray, as the single renderer does — its stored state is a placeholder GREEN.
  const ribbon = stateRibbon(estActive ? pts.slice(0, -1) : pts, undefined, meta.valueOnly ? () => "var(--ink-dim)" : null, geo);

  const unitWord = obsUnitWord(meta);
  const nowStr = latest != null ? `${esc(dLabel)} now ${esc(formatDerived(latest, dUnit))}` : `${esc(dLabel)} - history accruing`;
  // One legend clause per EXTRA secondary leg, same "now <value>" shape as the decision line's.
  const extraSecLegend = extraSec
    .map((a, si) => {
      const last = [...a].reverse().find((v) => v != null) ?? null;
      const name = esc(extraSecSpecs[si].label ?? dLabel);
      return last != null
        ? ` · ${name} now ${esc(formatDerived(last, dUnit))} (right, long-dashed)`
        : ` · ${name} - history accruing`;
    })
    .join("");

  const samples = pts.map((p, i) => {
    // S4b: the virtual estimate sample — neutral readout on the value axis, no state letter.
    if (estActive && i === n - 1) return estimateSample(est, n, lo, hi, geo, (v) => pFmt(v, pUnit));
    const dv = derived[i];
    const dTerm = dv != null ? ` · ${dLabel} ${formatDerived(dv, dUnit)}` : "";
    // Every trend overlay reads out, in spec order (EXSH_GATE: MA50 then MA200).
    const tTerm = trends
      .map((a, ti) => (a[i] != null ? ` · ${trendLabel(trendSpecs[ti])} ${formatValue(a[i], meta.unit)}` : ""))
      .join("");
    const oTerm = togArrs
      .map((a, si) => (togSeries[si].readout && a[i] != null ? ` · ${readoutName(togSeries[si])} ${formatValue(a[i], meta.unit)}` : ""))
      .join("");
    const gTerm = on[i] ? "" : " · gate off";
    // Every drawn line reads out on hover — a leg whose number you cannot see is the defect
    // this second series exists to close.
    const eTerm = extraSec
      .map((a, si) => (a[i] != null ? ` · ${extraSecSpecs[si].label ?? dLabel} ${formatDerived(a[i], dUnit)}` : ""))
      .join("");
    // Null-primary sample ⇒ dotY = null (no phantom dot / phantom `ys` entry at the plot floor).
    const dotY = Number.isFinite(values[i]) ? yAt(values[i], lo, hi, geo) : null;
    // Every drawn line's y at this column: the value line (dotY) + any primary trend overlay, on
    // the primary axis; the decision line + extra secondary legs, on ax2; the moving primary cuts.
    const py = (v) => yAt(v, lo, hi, geo);
    const ys = [];
    if (Number.isFinite(dotY)) ys.push(dotY);
    for (const arr of trends) pushY(ys, arr[i], py);
    pushY(ys, derived[i], ax2.scale);
    for (const arr of extraSec) pushY(ys, arr[i], ax2.scale);
    for (const arr of primCutArrs) pushY(ys, arr[i], py);
    const fitYs = [];
    togArrs.forEach((arr, si) => togSeries[si].style !== "dots" && pushY(fitYs, tog.inFrame(arr[i]), py));
    return {
      date: p.date,
      x: xAt(i, n, geo),
      dotY,
      ys,
      ...(togSeries.length ? { fitYs } : {}),
      // The primary line is NAMED in the readout whenever it is a scored leg rather than the price
      // (an unlabelled "-2.4%" beside the right axis' "-0.3%" reads as a second copy of one number).
      readout: `${p.date} · ${pName === "price" ? "" : `${pName} `}${pFmt(values[i], pUnit)}${tTerm}${oTerm}${dTerm}${eTerm}${gTerm} · ${p.state}${estMark(p)}`,
      chip: chipText({
        date: p.date,
        prim: pFmt(values[i], pUnit),
        sec: dv != null ? formatDerived(dv, dUnit) : null,
        state: p.state,
        tail: chipTrendTail(trends, trendSpecs, i, meta.unit),
      }),
    };
  });
  const detail = { n, samples, staticYs };

  const trendSvg = trendPaths
    .map(
      ({ d, s }) =>
        `<path class="line-trend" d="${d}" fill="none" stroke="${trendTone(s).stroke}" stroke-width="1.5" stroke-dasharray="6 3" />`,
    )
    .join("");
  // One legend clause per drawn trend line, its COLOUR always named — the decision line is dashed too,
  // so a dash word alone never says which line is the blue one (AT1's lone MA200, 2026-10-06). A LONE
  // line keeps the "long-dashed" cue; two or more share the dash, so the colour alone tells them apart.
  const trendLegend = trendPaths
    .map(({ s }) => ` · ${trendLabel(s)} (left, ${trendTone(s).word} ${trendPaths.length > 1 ? "dashed" : "long-dashed"})`)
    .join("");

  // The decision line's stroke: `--ink-dim` unless its spec carries a `tone` (EXSH_GATE's blue, chosen so
  // no two trend lines on one chart share a hue) — then the tone's hue, NAMED in the legend like a trend.
  const decisionStroke = decisionSpec?.tone ? trendTone(decisionSpec).stroke : "var(--ink-dim)";
  const decisionDash = decisionSpec?.tone ? `${trendTone(decisionSpec).word} dashed` : "dashed";

  const { estSvg, estLegend } = estimateOverlay(est, estActive, values, n, lo, hi, geo);
  const { intradaySvg, intradayLegend } = intradayOverlay(pts, estActive, values, n, lo, hi, geo);
  // S4b: the virtual slot is not an observation — the caption counts real closes only.
  const nObs = estActive ? n - 1 : n;

  const svg = `${chartOpen(chartTitle(meta), geo, chartHead(meta))}
    ${ax2.bandSvg}${cutSvg}${cutEdgeSvg}${lvlSvg}
    <path class="line" d="${valuePath}" fill="none" stroke="var(--ink)" stroke-width="1.75" />${trendSvg}${fitGroup}
    ${derivedPath ? `<path class="line-derived" d="${derivedPath}" fill="none" stroke="${decisionStroke}" stroke-width="1.5" stroke-dasharray="3 2" />` : ""}${extraSecSvg}${estSvg}${intradaySvg}
    ${ribbon}${yTicks}${axis1Label(pName, geo)}${ax2.yTicks2}${ax2.axis2Label}${hoverLayer({ geo, chip: true })}${axisXDates(pts, geo)}
  </svg>
  ${caption(meta, geo, `${primaryAxis(meta, pName === "price" ? labelUnit(meta) : pName.startsWith("Δ") ? velocityLabelUnit(meta, esc(pName)) : esc(pName))}${esc(trendLegend)}${tog.legend}${esc(cutLegend)}${esc(lvlLegend)} · ${nowStr} (right, ${decisionDash})${extraSecLegend} · ${nObs} ${unitWord}${nObs === 1 ? "" : "s"}${esc(estLegend)}${esc(intradayLegend)}${esc(gateLegend(spec, anyOff, false))}`)}`;
  return { svg, detail };
}

/** `genericSingle`'s `fit` lines (virtual axis): per-line scales, the hidden-group markup and the legend clauses. */
function fitOverlay(fitSeries, fitArrs, n, geo) {
  const PW = plotW(geo);
  // Each `fit` line's own scale: its visible extent mapped onto the full plot height (same 8% pad as the
  // primary). Drawn for it: the line + a very faint zero hairline (only when 0 is in range) so its sign
  // reads without a hover — no ticks, no label, no margin. Realized-vol lines (RV10 + RV20) pool ONE extent,
  // so their crossing is real; level-difference lines (R4's Δ63 + Δ120) pool another, so their zeros align;
  // every other fit line keeps its own. A `ref` value joins its pool's extent so the hairline stays in frame.
  const fitKey = (s, si) => (isRvHook(s) ? "rv" : s.compute === "delta" ? "delta" : `#${si}`);
  const sharesFit = (si) => fitSeries.filter((s, sj) => fitKey(s, sj) === fitKey(fitSeries[si], si)).length > 1;
  const fitPool = (si) =>
    fitArrs.flatMap((a, sj) => (fitKey(fitSeries[sj], sj) === fitKey(fitSeries[si], si) && a.some((v) => v != null) ? [...a, fitSeries[sj].ref?.value] : []));
  const fitRanges = fitArrs.map((_a, si) => {
    let [flo, fhi] = extent(fitPool(si).filter((v) => v != null));
    const fpad = (fhi - flo) * 0.08 || Math.abs(fhi) * 0.1 || 1;
    return [flo - fpad, fhi + fpad];
  });
  const fitScales = fitRanges.map(([flo, fhi]) => (v) => yAt(v, flo, fhi, geo));
  const fitSvg = fitArrs
    .map((a, si) => {
      const d = gapPathFor(a, n, fitScales[si], geo);
      if (!d) return "";
      const { stroke } = trendTone(fitSeries[si]);
      const [flo, fhi] = fitRanges[si];
      const zy = fitScales[si](0).toFixed(1);
      // One zero hairline per scale: a pooled scale's later lines share the first one's.
      const firstOfScale = fitSeries.findIndex((s, sj) => fitKey(s, sj) === fitKey(fitSeries[si], si)) === si;
      const zero =
        firstOfScale && flo < 0 && fhi > 0
          ? `<line data-fit-zero x1="${geo.ml}" x2="${geo.ml + PW}" y1="${zy}" y2="${zy}" stroke="${stroke}" stroke-width="0.75" opacity="0.2" />`
          : "";
      const rv = fitSeries[si].ref?.value;
      const ry = rv == null ? null : fitScales[si](rv).toFixed(1);
      const ref =
        ry == null
          ? ""
          : `<line data-fit-ref x1="${geo.ml}" x2="${geo.ml + PW}" y1="${ry}" y2="${ry}" stroke="${stroke}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5" />`;
      return `${zero}${ref}<path class="line-trend" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="6 3" />`;
    })
    .join("");
  // Named only where a line was drawn (a cold/short series has no Δ to show).
  const fitLegend = fitSeries
    .map((s, si) => [s, si])
    .filter(([_s, si]) => fitArrs[si].some((v) => v != null))
    .map(([s, si]) => {
      const scale = !sharesFit(si) ? "own" : isRvHook(s) ? "shared RV" : "shared Δ";
      const ref = s.ref ? `, ${s.ref.label} line` : "";
      return ` · <button class="fit-toggle" type="button">${esc(trendLabel(s))} (${trendTone(s).word}, ${scale} scale${esc(ref)} - value on hover)</button>`;
    })
    .join("");
  return { fitScales, fitSvg, fitLegend };
}

/** `genericSingle`'s secondary (right) axis; pushes its static band y's onto `staticYs`. */
function secondaryOverlay(secAxisSpec, secArrs, spec, resolveBand, secMasks, splitByGate, staticYs, n, geo) {
  const secImaged = [];
  const derived = secArrs[0];
  const dLabel = secAxisSpec.label;
  const dUnit = secAxisSpec.unit;
  // A "pp" value-format axis is a dual-axis level-Δ of a %-quoted id (F1/F2/R4/T10YIE/T5YIFR) — named,
  // so it never reads relative. (R7's "pp" axis is format "derived" and never reaches this branch.)
  const dFmt = secAxisSpec.format === "derived" ? formatDerived : (v, u) => (u === "pp" ? formatLevelDelta(v, u) : formatValue(v, u));
  const secBands = spec.bands
    .filter((b) => b.axis === "secondary")
    .map((b) => [b.level, resolveBand(b), b.label, b.style])
    .filter(([, v]) => v != null);
  // Domain = UNION of ALL secondary series; a perPoint cut is dropped
  // by `resolveBand` above, so the four moving cuts never join the domain (D0-a). One path per series.
  const ax2 = secondaryAxis({ series: secArrs.flat(), bands: secBands, label: dLabel, unit: dUnit, n, format: dFmt, geo });
  secImaged.push(...secBands.map(([, v]) => v));
  staticYs.push(...ax2.bandYs); // the secondary static bands (always in-frame; folded into the domain)
  const derivedPaths = secArrs.map((a, si) => splitByGate(a, secMasks[si], ax2.scale));
  return { ax2, derived, derivedPaths, dLabel, dUnit, dFmt, secImaged };
}

/**
 * Generic single-axis layout: value (or Δ20) line + amber/red bands + ribbon,
 * all on the primary axis. Bands resolve by `source`: `threshold` reads the static
 * `thresholds` per-field, overridden wholesale by `eff` when the recompute envelope
 * carries it; `displayBand` bands are baked (value + label). Mirrors `detailChart`.
 */
function genericSingle(meta, allPts, eff, spec, primAxis, primSeriesAll, secAxisSpec, secSeries = [], geo = CH) {
  const PW = plotW(geo);
  // `fit` series (the Δ5 line on F1/CCC) ride a VIRTUAL axis — pulled out of the primary set so they
  // never join its domain, ticks or legend slot; drawn below on their own fitted scale.
  const fitSeries = primSeriesAll.filter((s) => s.fit);
  // `toggle` overlays (Value XDEV's 60-close high, € zones, veto dots) ride the same hidden group on the PRIMARY
  // scale — pulled out too, so they never join its domain (the default, hidden frame stays unchanged) or its legend.
  const togSeries = primSeriesAll.filter((s) => s.toggle && !s.fit);
  const primSeries = fitSeries.length || togSeries.length ? primSeriesAll.filter((s) => !s.fit && !s.toggle) : primSeriesAll;
  const primary = primSeries[0];
  const velocityMode = primary.fromPoint === "delta20";

  // Static registry/vintage cut pair, overridden wholesale by `eff` when present
  // (exactly the bespoke chain).
  const t = meta.thresholds || {};
  const hasEffective = eff != null && eff.effAmber !== undefined && eff.effRed !== undefined;
  // `legBands`: the spec draws every drawable OR-leg as its own pair, opting OUT of the worst-of
  // composite (`eff`, a min across legs) — guards against a vintage re-emitting a proxy `zref` cut
  // in the wrong units that would dominate the operative pair the leg lines exist to show.
  const legBands = spec.legBands === true;

  const resolveBand = (b) => {
    // A perPoint band's value is a per-DATE series read off `bandCuts`, never a scalar this
    // layout can resolve. Without this arm it falls through to the threshold/effective
    // branches and draws a STATIC registry cut under a moving-percentile label — a wrong
    // number wearing the right caption, invisible to every test. Inert for CG (its perPoint
    // pair rides genericDerived), live for the next `levelBand` id on this layout.
    if (b.source === "perPoint") return undefined;
    if (b.source === "displayBand" || b.source === "derived") return b.value;
    if (b.source === "effective") return b.level === "amber" ? eff?.effAmber : eff?.effRed;
    // threshold: eff overrides both legs; else the merged cell/static pair.
    // `eff` overrides the LEVEL pair only — `effectiveCuts` computes an early-warning shift of the
    // level cut, so letting it win on a VELOCITY band (F1's Δ30d pair) would paint a level number
    // on a velocity axis. Without this guard `?early=` silently mislabels that axis.
    if (hasEffective && !legBands && b.metric !== "velocity")
      return b.level === "amber" ? eff.effAmber : eff.effRed;
    if (b.metric === "velocity") return b.level === "amber" ? t.amberVelocity : t.redVelocity;
    return b.level === "amber" ? t.amberLevel : t.redLevel;
  };

  // Compute all series on the FULL point array first, so a windowed compute (the
  // `lead` buffer, e.g. F1's roc30 lookback) is defined before we slice — then keep
  // only the trailing `spec.window ?? DETAIL_LIMIT` points (`specWindowStart`; genericDerived ignores `window`).
  // Live consumers: F9 emits secondary series and F11 a `window` (CHART_PARAMS_OF,
  // src/family-descriptor-rows.ts); an id declaring neither slices at DETAIL_LIMIT unchanged.
  const allValues = seriesValues(primary, allPts);
  // R4 % axis baseline: the first value of the default frame (or of a chip-EXPANDED one) — never of the spec's
  // `lead` warm-up before it, and never re-based by a narrowing chip.
  const pctId = meta.channel === "PENSION" && !velocityMode;
  const pctFrom = Math.min(specWindowStart(allPts, spec), specWindowStart(allPts, spec, null));
  const pctBase = pctId ? (allValues.slice(pctFrom).find((v) => Number.isFinite(v)) ?? null) : null;
  // Extra PRIMARY-axis overlays beyond the value line (F1's `lowRise` credit leg) — computed over the
  // FULL allPts so their own lookback is warm at the visible edge, then sliced with `values`. A
  // one-primary-series spec (every other single-layout id) leaves this empty ⇒ byte-identical output.
  const extraPrim = primSeries.slice(1);
  const extraPrimAll = extraPrim.map((s) => seriesValues(s, allPts));
  const secArrsAll = (secSeries ?? []).map((s) => seriesValues(s, allPts));
  const fitArrsAll = fitSeries.map((s) => seriesValues(s, allPts));
  const togArrsAll = togSeries.map((s) => seriesValues(s, allPts));
  const start = specWindowStart(allPts, spec);
  const pts = allPts.slice(start);
  const values = allValues.slice(start);
  const extraPrimArrs = extraPrimAll.map((a) => a.slice(start));
  const secArrs = secArrsAll.map((a) => a.slice(start));
  const fitArrs = fitArrsAll.map((a) => a.slice(start));
  const togArrs = togArrsAll.map((a) => a.slice(start));
  const n = pts.length;
  const { fitScales, fitSvg, fitLegend } = fitOverlay(fitSeries, fitArrs, n, geo);
  // A fit line's readout units: the value's own (the Δ5 is a level difference on every id) — except a
  // %-quoted level (F1/CCC OAS), whose difference is percentage POINTS: "-0.06%" would read as relative.
  // A bp level (BONOS) names its unit too, so the hover matches the re-entry rule's number AND unit.
  // A realized-vol hook (Value XDEV's RV10) is an annualised FRACTION ⇒ a percent.
  const fitFmt = (s, v) => (isRvHook(s) ? formatDerived(v, "%") : formatLevelDelta(v, meta.unit === "%" ? "pp" : meta.unit));

  // Gate state per secondary series (R7's `shortEndDriven` shade): a gate-off
  // day draws the leg dim/dashed, reusing `gateOnAt`. A non-gated series' mask is ALL-TRUE, so its
  // path stays byte-identical (F1 ROC / R8 probit). `gateOn` is the per-point AND used by the hover.
  const secMasks = secSeries.map((s) => pts.map((p) => gateOnAt(p, s.gatedBy)));
  // …and on the PRIMARY line too (DB_SMH/DB_XLK, whose SCORED variable is the primary drawdown —
  // there is no secondary line to carry the dimming). A spec with no `gatedBy` on its primary
  // series yields an all-TRUE mask, so every other single-axis id renders byte-identically.
  const primMask = pts.map((p) => gateOnAt(p, primary.gatedBy));
  const gateOn = pts.map((_, i) => primMask[i] && secMasks.every((m) => m[i]));
  const anyGateOff = primMask.some((v) => !v) || secMasks.some((m) => m.some((v) => !v));
  // Split a secondary series into gate-ON and gate-OFF paths (against the ax2 scale). All-TRUE mask
  // ⇒ off:"" and on ≡ `ax2.pathFor(arr)` byte-for-byte; a boundary point rides BOTH runs so the
  // dim and full segments connect.
  const splitByGate = (arr, mask, scale) => {
    let onPath = "";
    let offPath = "";
    let run = [];
    let runOff = false;
    const flush = () => {
      if (run.length) {
        const d = pathD(run) + " ";
        if (runOff) offPath += d;
        else onPath += d;
      }
      run = [];
    };
    arr.forEach((v, i) => {
      if (v == null) {
        flush();
        return;
      }
      const off = !mask[i];
      const pt = [xAt(i, n, geo), scale(v)];
      if (run.length && off !== runOff) {
        run.push(pt);
        flush();
      }
      runOff = off;
      run.push(pt);
    });
    flush();
    return { on: onPath.trim(), off: offPath.trim() };
  };

  // Primary-axis bands only (secondary bands ride axis-2 below). Today no
  // single-layout band carries an `axis`, so the filter is a no-op.
  // [kind, value, label?] tuples in spec order (amber, red).
  let bands = spec.bands
    .filter((b) => (b.axis ?? "primary") === "primary")
    .map((b) => {
      const v = resolveBand(b);
      // 4th slot = the band's render style ("evt" → dotted; absent → the plain dashed cut).
      return b.label != null ? [b.level, v, b.label, b.style, b.pair] : [b.level, v, undefined, b.style, b.pair];
    });
  // D0-a: frame to the plotted DATA only — a band (esp. one shifted by ?early=)
  // must move on screen, not drag the y-domain with it; off-range cuts become
  // ▼/▲ edge markers in bandCutSvg.
  // Fold any extra primary overlay into the DATA domain so a small-magnitude leg (F1's lowRise sits
  // near 0..3 under an OAS line at 3..8) and its amber onset stay on-plot rather than pinned as an
  // edge marker. Empty extras ⇒ `extent([...values])` === `extent(values)`, byte-identical.
  // A served `axes[primary].domain` (an integer rank's fixed range) replaces the data extent outright.
  let [lo, hi] = primAxis?.domain
    ? primAxis.domain
    : extent([
        ...values,
        ...extraPrimArrs.flat().filter((v) => v != null),
      ]);
  const padY = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  lo -= padY;
  hi += padY;

  const tog = toggleOverlays(togSeries, togArrs, lo, hi, n, geo);

  const unitWord = obsUnitWord(meta);
  const linePts = values.map((v, i) => [xAt(i, n, geo), yAt(v, lo, hi, geo)]);
  // Gated primary line: the gate-OFF runs draw FAINTER ONLY — same stroke, same (absent) dash as
  // the gate-on run, against the PRIMARY scale. The dash was dropped 2026-08-31 (backlog #37): a
  // `2 4` degrade at 0.35 opacity fragmented a leg into speckle over a long gate-off stretch, and
  // opacity alone already separates the two states. `opacity="0.35"` — NOT the dasharray — is what
  // `detail-chart.test.js` keys gate-off on, so the degrade stays assertable. An all-TRUE mask returns `on` ≡ the plain
  // `pathD(linePts)` and `off` === "", so the ungated ids keep byte-identical markup.
  const primGateOff = primMask.some((v) => !v);
  // Only a PRIMARY gate-off splits the line — a secondary leg's own gate must not re-render this
  // path (the split output is equivalent, not byte-identical, and every existing snapshot pins it).
  const primSplit = primGateOff ? splitByGate(values, primMask, (v) => yAt(v, lo, hi, geo)) : null;
  const primaryLineSvg = primGateOff
    ? `${primSplit.on ? `<path class="line" d="${primSplit.on}" fill="none" stroke="var(--ink)" stroke-width="1.75" />` : ""}${
        primSplit.off ? `<path class="line" d="${primSplit.off}" fill="none" stroke="var(--ink)" stroke-width="1.75" opacity="0.35" />` : ""
      }`
    : `<path class="line" d="${primary.style === "step" ? stepPathD(linePts) : pathD(linePts)}" fill="none" stroke="var(--ink)" stroke-width="1.75" />`;
  // Gap-broken overlay paths on the SAME primary scale (dim + dashed, like the secondary derived
  // lines) — one per extra primary series, empty for the common one-series spec.
  const extraPrimSvg = extraPrimArrs
    .map((arr, i) => {
      const d = gapPathFor(arr, n, (v) => yAt(v, lo, hi, geo), geo);
      if (!d) return "";
      // A `scored-mean` overlay IS a scored metric (R1's 63-obs mean) — SOLID `--trend-line` at 1.25,
      // the load-bearing distinction from a dashed derived/trend overlay (solid = scored, not derived).
      return extraPrim[i].style === "scored-mean"
        ? `<path class="line-scored" d="${d}" fill="none" stroke="var(--trend-line)" stroke-width="1.25" />`
        : `<path class="line-derived" d="${d}" fill="none" stroke="var(--ink-dim)" stroke-width="1.5" stroke-dasharray="3 2" />`;
    })
    .join("");
  const extraPrimLegend = extraPrim
    .map((s) => ` · ${s.label ?? "overlay"}${s.style === "scored-mean" ? " (blue)" : " (left, dashed)"}`)
    .join("");

  // PER-POINT (MOVING) primary cuts (F9's rolling-σ velocity band, `amber × σ(t)`) — the shared
  // `perPointCuts` helper; its docblock carries the gap/edge-marker rationale.
  // ⚠ FORMATTER: here the cut lives on the PLOTTED axis (raw Δw index points, or the value axis),
  // so it takes the SAME formatter this layout's own ticks and scalar bands use — otherwise the
  // drawn line's label disagrees with the ticks it sits between.
  const cutFmt = (v) => formatValue(v, velocityMode ? "" : meta.unit);
  const cutPathFor = (arr) => gapPathFor(arr, n, (v) => yAt(v, lo, hi, geo), geo);
  const { cutSvg, cutEdgeSvg, cutLegend, drawnArrs: primCutArrs, imaged: primCutImaged } = perPointCuts({
    spec,
    pts,
    axis: "primary",
    lo,
    hi,
    pathFor: cutPathFor,
    fmt: cutFmt,
    drawnSuffix: " (dashed)",
    geo,
  });

  const edgeSeen = { below: 0, above: 0 };
  // STATIC band y's for the S4 parking walk: the in-frame primary cuts here, plus any secondary-axis
  // bands pushed once `ax2` exists (below). The MOVING perPoint cuts (primary + R7's secondary four)
  // are per-index and already ride each sample's `ys`, so they are NOT static.
  const staticYs = [];
  const bandSvg = bands
    .filter(([, v]) => v != null)
    .map(([kind, v, label, style, pair]) =>
      bandCutSvg(kind, v, lo, hi, label ?? `${kind} ${formatValue(v, velocityMode ? "" : meta.unit)}`, edgeSeen, style, geo, PAIR_HUES[pair] ?? null, staticYs),
    )
    .join("");
  // Off by default: `.fit-lines` is display:none until a legend `.fit-toggle` puts `.show-fit` on the page root
  // (styles.css + fit-toggle.js) — one shared switch for every chart's fit lines + toggle overlays, surviving re-renders.
  const togEdgeSvg = tog.edgeSvg(edgeSeen, cutFmt);
  const fitGroup = fitSvg || tog.svg || togEdgeSvg ? `<g class="fit-lines">${tog.svg}${togEdgeSvg}${fitSvg}</g>` : "";

  const yTicks = [lo + padY, hi - padY]
    .map(
      (v) =>
        `<text class="axis-y" x="${geo.ml - 8}" y="${(yAt(v, lo, hi, geo) + 3).toFixed(1)}">${esc(formatValue(v, velocityMode ? "" : meta.unit))}</text>`,
    )
    .join("");

  // Optional secondary (right) axis for a non-decision derived overlay (F1's ROC).
  // Mirrors genericDerived's axis-2 block — a deliberate mirror, kept separate because the two
  // layouts resolve bands/formatters differently. Null when no secondary series ⇒ byte-identical
  // to the pre-batch single-axis output for every existing id.
  let ax2 = null;
  let derived = null;
  let derivedPaths = [];
  let dLabel = "";
  let dUnit = "";
  // The secondary axis's ONE formatter — bands, ticks AND the hover readout below all take it,
  // so a value on the right axis reads the same however you look at it.
  // It honours the axis's declared `format`: "derived" on this layout = a relative-speed id's fraction
  // (chart-rail.ts `dualAxisChart`); the derived-layout renderer above keeps its own `formatDerived`.
  let dFmt = formatValue;
  let secImaged = []; // every cut value with an image on ax2 (static bands + moving cuts' newest)
  if (secAxisSpec && secArrs.length) {
    ({ ax2, derived, derivedPaths, dLabel, dUnit, dFmt, secImaged } = secondaryOverlay(secAxisSpec, secArrs, spec, resolveBand, secMasks, splitByGate, staticYs, n, geo));
  }
  // R4: a PENSION id's right axis relabels the primary y as % off `pctBase` (fit/toggle overlays keep their own
  // scales). It yields to a declared secondary axis, and needs a base (an all-null redacted series has none).
  const pctOn = pctId && !ax2 && pctBase != null;
  const pctOf = (v) => (pctBase ? (v / pctBase - 1) * 100 : 0);
  const pctAxisSvg = pctOn
    ? [lo + padY, hi - padY]
        .map(
          (v) =>
            `<text class="axis-y" x="${geo.ml + PW - 2}" y="${(yAt(v, lo, hi, geo) + 3).toFixed(1)}" text-anchor="end" fill="var(--ink-dim)">${esc(formatValue(pctOf(v), "%"))}</text>`,
        )
        .join("") + axisName("% change", geo.w - 3, geo)
    : "";
  // One dim/dashed line per secondary series; a gate-OFF run draws fainter + tighter-dashed. For a
  // non-gated N=1 series (F1 ROC / R8 probit) the `on` path is byte-identical to the pre-N-series output.
  const derivedPathsSvg = derivedPaths
    .map(({ on, off }, si) => {
      // A paired leg (R7) takes its pair hue on BOTH runs — the gate-off segment keeps its
      // opacity degrade with only the hue swapped in. Pair-less series: ink-dim, as today.
      // ⚠ The gate-off run carries the SAME `3 2` dash as its gate-on sibling, not a tighter one:
      // `3 2` is the derived-LINE convention (it is what makes a secondary leg read as derived),
      // so the two runs must share it or the faint segment reads as a different series. Dropping
      // it here would make gate-off SOLID while gate-on stays dashed — the degrade inverted.
      // Was `2 4` until 2026-08-31 (backlog #37); opacity carries the whole degrade now.
      const stroke = PAIR_HUES[secSeries[si]?.pair] ?? "var(--ink-dim)";
      return (
        (on ? `\n    <path class="line-derived" d="${on}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="3 2" />` : "") +
        (off ? `\n    <path class="line-derived" d="${off}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.35" />` : "")
      );
    })
    .join("");

  // SECONDARY-axis perPoint cuts (R7's four moving ranked cuts) — scaled against the ax2 range, NOT
  // the primary [lo,hi]. Off-range newest cut ⇒ the shared ▼/▲ edge marker + "below/above plot" note.
  let secCutSvg = "";
  let secCutChipSvg = "";
  let secCutEdgeSvg = "";
  let secCutLegend = "";
  let secCutArrs = []; // per-index clamped arrays of the DRAWN secondary moving cuts (R7's four) — for `ys`
  if (ax2) {
    const slo = ax2.lo;
    const shi = ax2.hi;
    const secCutPathFor = (arr) => gapPathFor(arr, n, ax2.scale, geo);
    const secCuts = spec.bands
      .filter((b) => b.source === "perPoint" && b.axis === "secondary")
      .map((b) => {
        let last = null; // newest FINITE cut, in-domain or not — what the legend reports
        const arr = pts.map((p) => {
          const v = p.bandCuts?.[b.fromPoint];
          if (typeof v !== "number" || !Number.isFinite(v)) return null;
          last = v;
          return v >= slo && v <= shi ? v : null;
        });
        return { band: b, arr, path: secCutPathFor(arr), last, off: last != null && (last < slo || last > shi) };
      });
    const drawn = secCuts.filter((c) => c.path);
    secCutArrs = drawn.map((c) => c.arr);
    // `seen` is shared with the edge markers below, but the two sets use DISJOINT fields —
    // in-range labels only `labelYs`, edge markers only `below`/`above`. Shared so a future
    // cut that moves between the two regimes keeps one counter, not so they stagger together.
    const seen = { below: 0, above: 0 };
    // Chip lane: x just OUTSIDE the plot frame, in the right margin the rotated axis label shares
    // (the chip carries a `--bg` halo in the sheet, and is emitted after that label, so the two
    // can overlap without either becoming unreadable).
    const chipX = (geo.ml + plotW(geo) + 2).toFixed(1);
    const chips = [];
    secCutSvg = drawn
      .map((c) => {
        // A paired cut takes its LEG's hue; severity moves to weight/dash (red = heavier + denser,
        // amber keeps today's stroke) and stays in the label text. Pair-less: severity hue, as today.
        const hue = PAIR_HUES[c.band.pair];
        const color = hue ?? (c.band.level === "red" ? "var(--state-red)" : "var(--state-amber)");
        // "approach" = a display-only reference line (a `refSigma` 1σ), never a cut: DOTTED + half-strength
        // stroke so it can't be misread as the amber cut it shares a hue with; label stays full strength.
        const approach = c.band.style === "approach";
        const [width, dash] = approach ? ["1.25", "1 3"] : hue && c.band.level === "red" ? ["1.75", "2 2"] : ["1.25", "4 3"];
        const faint = approach ? ' opacity=".5"' : "";
        const path = `<path class="band-cut"${faint} d="${c.path}" fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" />`;
        // A MOVING cut has no single y, so the label anchors at its newest ON-PLOT point and sits
        // right-aligned, beside the secondary axis it is scaled against.
        let j = c.arr.length - 1;
        while (j >= 0 && c.arr[j] == null) j--;
        if (j < 0) return path;
        // A `shortLabel` cut paints its 2-glyph CHIP in the right margin instead — outside the
        // plot, so the newest observations stay uncovered (`[USER]` 2026-08-29). Its y is clamped
        // into the frame BEFORE staggering, so a chip never rides off the top/bottom edge.
        if (c.band.shortLabel) {
          const anchor = Math.min(Math.max(ax2.scale(c.arr[j]), geo.mt + 11), geo.mt + plotH(geo) - 2);
          const cy = stackedLabelY(seen, anchor);
          chips.push(
            `<text class="band-chip" x="${chipX}" y="${cy.toFixed(1)}" text-anchor="start" fill="${color}">${esc(c.band.shortLabel)}</text>`,
          );
          return path;
        }
        const ly = stackedLabelY(seen, ax2.scale(c.arr[j]));
        const x = (geo.ml + plotW(geo) - 4).toFixed(1);
        return `${path}<text class="band-label" x="${x}" y="${ly.toFixed(1)}" text-anchor="end" fill="${color}">${esc(c.band.label ?? c.band.level)}</text>`;
      })
      .join("");
    secCutChipSvg = chips.join("");
    // An OFF-plot cut keeps the shared ▼/▲ marker, but a chipped band shows only its chip there
    // too — its value is one line down in the legend, and the long text sat over the data.
    secCutEdgeSvg = secCuts
      .filter((c) => c.off)
      .map((c) =>
        bandCutSvg(
          c.band.level,
          c.last,
          slo,
          shi,
          c.band.shortLabel ?? `${c.band.label ?? c.band.level} ${dFmt(c.last, dUnit)}`,
          seen,
          c.band.style ?? null,
          geo,
          PAIR_HUES[c.band.pair] ?? null,
        ),
      )
      .join("");
    const legendCuts = secCuts.filter((c) => c.last != null);
    secImaged.push(...legendCuts.map((c) => c.last));
    secCutLegend = legendCuts.length
      ? ` · ${legendCuts
          .map(
            (c) =>
              `${c.band.shortLabel ? `${c.band.shortLabel} = ` : ""}${c.band.label ?? c.band.level} now ${dFmt(c.last, dUnit)}${
                c.off ? (c.last < slo ? " (below plot)" : " (above plot)") : ""
              }`,
          )
          .join(" · ")}${drawn.length ? " (right, dashed)" : ""}`
      : "";
  }
  // σ(t) off the σ-REFERENCE line (a `refSigma` 1σ, `sigmaMultiple`) — read UNCLAMPED, so an off-plot ref still
  // reads out. The hover prints σ and z = Δ ÷ σ: the EU-Fin `t2-gilt` "z(Δ20) < 1" check, read on the chart.
  const sigmaRef = ax2 ? spec.bands.find((b) => b.source === "perPoint" && b.axis === "secondary" && b.sigmaMultiple > 0) : null;
  const sigmaAt = (i) => {
    const v = sigmaRef ? pts[i].bandCuts?.[sigmaRef.fromPoint] : null;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v / sigmaRef.sigmaMultiple : null;
  };

  // Ribbon colour override:
  //  • F7/CAPE — colour by the plotted value vs the SAME drawn band lines (p80 amber / p95 red,
  //    HIGH-firing): red at/above the red cut, amber at/above the amber cut, green below — so
  //    line and ribbon can never disagree. NOT from p.state, which is a placeholder GREEN.
  //  • other value-only ids — neutral gray (their state is placeholder GREEN, not a real verdict).
  // Absent ⇒ null ⇒ the normal confirmed-state ribbon for every scored id (byte-identical).
  const capeAmber = meta.id === "F7" ? bands.find(([kind]) => kind === "amber")?.[1] : null;
  const capeRed = meta.id === "F7" ? bands.find(([kind]) => kind === "red")?.[1] : null;
  const ribbonFill =
    capeAmber != null
      ? (p) =>
          p.value != null && capeRed != null && p.value >= capeRed
            ? STATE_COLORS.RED
            : p.value != null && p.value >= capeAmber
              ? STATE_COLORS.AMBER
              : STATE_COLORS.GREEN
      : meta.valueOnly
        ? () => "var(--ink-dim)"
        : null;
  const ribbon = stateRibbon(pts, (p) => (p.leg ? ` - via ${legPhrase(p.leg)}` : ""), ribbonFill, geo);

  // The velocity caption comes from the PRIMARY AXIS' server-composed `label` ("Δ60d", "Δ4w",
  // "Δ20d" — `velocitySpanWord` in `chart-rail.ts`), never a literal: the span is per-id
  // (the registry's `velocityWindow`) and the per-observation WORD resolves from
  // `obsCadence ?? cadence` — the same expression `obsUnitWord` at the top of this file uses,
  // since slice 2 put `obsCadence` on the wire; taking the server's finished label keeps ONE
  // composer for the span, not two. The old hardcoded "Δ20 (20-day change)" was already wrong
  // for F1/F3 and 3× wrong for F9.
  // ⚠ Do NOT prefix `meta.label` here — the legend line below already renders
  // `${meta.label} ${metric}` (`velocityLabelUnit`), which is exactly why the rail omits the id
  // prefix on THIS axis (its docblock says so) while the dual-axis SECONDARY caption keeps one.
  // Fallback for a spec with no label (old payload): a span-free "Δ (change)" — it must never
  // re-assert "20", which is the bug this replaces.
  const metricName = velocityMode ? (primAxis?.label ?? "Δ (change)") : `value${meta.unit ? ` (${meta.unit})` : ""}`;
  const metric = esc(metricName);
  // N=1 (F1 ROC / R8 probit) keeps the axis label; N>1 (R7's two legs) names each by its series
  // `label` so the two indistinguishable dim lines are legible.
  const dTermLegend = ax2
    ? ` · ${
        secArrs.length > 1
          ? secSeries
              .map((s) => {
                // A paired leg's legend entry carries its hue; pair-less names stay plain text.
                const hueCls = PAIR_HUE_CLASS[s.pair];
                const name = esc(s.label ?? dLabel);
                return hueCls ? `<span class="${hueCls}">${name}</span>` : name;
              })
              .join(" / ")
          : esc(dLabel)
      } (right, dashed)`
    : "";

  const samples = pts.map((p, i) => {
    let dTerm;
    if (secArrs.length > 1) {
      dTerm = secArrs.map((a, si) => (a[i] != null ? ` · ${secSeries[si].label ?? dLabel} ${dFmt(a[i], dUnit)}` : "")).join("");
    } else {
      const dv = derived ? derived[i] : null;
      dTerm = dv != null ? ` · ${dLabel} ${dFmt(dv, dUnit)}` : "";
    }
    const sg = sigmaAt(i);
    const z = sg != null && derived?.[i] != null ? `z ${(derived[i] / sg).toFixed(2)}` : null;
    const sTerm = sg != null ? ` · σ ${dFmt(sg, dUnit)}${z ? ` · ${z}` : ""}` : "";
    // Extra PRIMARY overlays (DB_*'s MA50-as-drawdown gate line, F1's lowRise leg) read out too —
    // they are drawn lines, so hovering must give their number like any other series. Name = the
    // series' LEAD CLAUSE (`readoutName`), not the full legend label.
    const pTerm = extraPrimArrs
      .map((a, si) => (a[i] != null ? ` · ${readoutName(extraPrim[si])} ${formatValue(a[i], velocityMode ? "" : meta.unit)}` : ""))
      .join("");
    // `fit` lines (virtual axis) — the hover is the ONLY place their number shows; units per `fitFmt` (pp on a %-unit id).
    const fTerm = fitArrs
      .map((a, si) => (a[i] != null ? ` · ${readoutName(fitSeries[si])} ${fitFmt(fitSeries[si], a[i])}` : ""))
      .join("");
    // `readout` toggle lines (EU-Fin EXSH's MA50/MA200) print their value — on or off frame — in the readout only.
    const oTerm = togArrs
      .map((a, si) => (togSeries[si].readout && a[i] != null ? ` · ${readoutName(togSeries[si])} ${formatValue(a[i], meta.unit)}` : ""))
      .join("");
    const gTerm = gateOn[i] ? "" : " · gate off";
    const pctStr = pctOn && Number.isFinite(values[i]) ? formatValue(pctOf(values[i]), "%") : null;
    // Null-primary sample ⇒ dotY = null (no phantom dot / phantom `ys` entry at the plot floor).
    const dotY = Number.isFinite(values[i]) ? yAt(values[i], lo, hi, geo) : null;
    // Every drawn line's y at this column: the value line (dotY) + extra primary overlays + moving
    // primary cuts, on the primary axis; and — where an ax2 exists — its series + moving cuts (R7).
    const py = (v) => yAt(v, lo, hi, geo);
    const ys = [];
    if (Number.isFinite(dotY)) ys.push(dotY);
    for (const arr of extraPrimArrs) pushY(ys, arr[i], py);
    for (const arr of primCutArrs) pushY(ys, arr[i], py);
    // Fit lines are hidden by default, so their y's ride a separate `fitYs` — hover-readout parks the
    // chip around them only while `.show-fit` is on (never dodging a line the reader cannot see).
    const fitYs = [];
    fitArrs.forEach((arr, si) => pushY(fitYs, arr[i], fitScales[si]));
    // …and the toggle overlays' in-frame lines (hidden by the same switch; a dot is a mark, not a line).
    togArrs.forEach((arr, si) => togSeries[si].style !== "dots" && pushY(fitYs, tog.inFrame(arr[i]), py));
    if (ax2) {
      for (const arr of secArrs) pushY(ys, arr[i], ax2.scale);
      for (const arr of secCutArrs) pushY(ys, arr[i], ax2.scale);
    }
    const fx = FX_PCT_IDS.has(meta.id) ? fxPctTerms(pts, i, meta.velocityWindow) : null;
    return {
      date: p.date,
      x: xAt(i, n, geo),
      dotY,
      ys,
      ...(fitSeries.length || togSeries.length ? { fitYs } : {}), // absent without fit/toggle lines — every other sample stays byte-identical
      readout: `${p.date} · ${formatValue(values[i], velocityMode ? "" : meta.unit)}${fx ? ` (${fx.chg})` : ""}${pctStr != null ? ` · ${pctStr}` : ""}${pTerm}${fTerm}${oTerm}${dTerm}${sTerm}${gTerm} · ${p.state}${estMark(p)}`,
      chip: chipText({
        date: p.date,
        prim: `${formatValue(values[i], velocityMode ? "" : meta.unit)}${fx ? ` (${fx.chg})` : ""}`,
        // Only the FIRST secondary line (`derived` === secArrs[0] whenever ax2 exists): a 2-leg
        // id would double the chip's width, and the strip already prints every leg.
        sec: ax2 && derived?.[i] != null ? dFmt(derived[i], dUnit) : pctStr,
        state: p.state,
        // σ itself stays in the docked strip; the chip carries only the number the threshold reads, plus
        // the fit lines' values (their only on-chart number — the lines are hidden by default) — a `readout` one excepted.
        tail: [z, ...fitArrs.map((a, si) => (a[i] != null && !fitSeries[si].readout ? `${readoutName(fitSeries[si])} ${fitFmt(fitSeries[si], a[i])}` : null))].filter(Boolean).join(" · ") || null,
      }),
    };
  });
  const detail = { n, samples, staticYs };

  // #6/#7 tail: the scored-on clause + the cut guide. Level legs judge their bounds against the
  // axis they score on: in level mode that is the primary axis; `vel-*` legs take the Δ axis —
  // ax2 where one exists, the primary itself in velocityMode, else a fmt-only fallback (primary
  // formatter, no above/below-plot side note — no velocity axis is in scope on this frame).
  // `imaged` = the cut values this axis draws (static bands + moving cuts' newest, in-frame or edge
  // marker), so the guide can say which legs' cuts the reader can find and which are not drawn.
  const primImaged = [...bands.filter(([, v]) => v != null).map(([, v]) => v), ...primCutImaged];
  const primAxisDesc = { fmt: cutFmt, lo, hi, imaged: primImaged };
  const velAxisDesc = velocityMode
    ? primAxisDesc
    : ax2
      ? { fmt: (v) => dFmt(v, dUnit), lo: ax2.lo, hi: ax2.hi, imaged: secImaged }
      : { fmt: cutFmt };
  const levelAxisDesc = velocityMode ? { fmt: cutFmt } : primAxisDesc;
  const scored = hasEffective ? scorerLegend(eff) : "";
  const scoredClause = hasEffective ? `${scored ? ` · ${scored}` : ""}${cutGuide(eff, levelAxisDesc, velAxisDesc)}` : "";

  const { intradaySvg, intradayLegend } = intradayOverlay(pts, false, values, n, lo, hi, geo);

  const svg = `${chartOpen(chartTitle(meta), geo, chartHead(meta))}
    ${bandSvg}${cutSvg}${cutEdgeSvg}${ax2 ? ax2.bandSvg : ""}${secCutSvg}${secCutEdgeSvg}
    ${primaryLineSvg}${extraPrimSvg}${fitGroup}${derivedPathsSvg}${intradaySvg}
    ${ribbon}${yTicks}${axis1Label(metricName, geo)}${ax2 ? ax2.yTicks2 : ""}${ax2 ? ax2.axis2Label : ""}${pctAxisSvg}${secCutChipSvg}${hoverLayer({ geo, chip: true })}${axisXDates(pts, geo)}
  </svg>
  ${caption(meta, geo, `${primaryAxis(meta, velocityMode ? velocityLabelUnit(meta, metric) : labelUnit(meta))}${esc(extraPrimLegend)}${tog.legend}${fitLegend}${esc(cutLegend)}${esc(secCutLegend)}${dTermLegend}${pctOn ? " · % change (right)" : ""} · ${n} ${unitWord}${n === 1 ? "" : "s"}${esc(intradayLegend)}${scoredClause}${esc(gateLegend(spec, anyGateOff, true))}`)}`;
  return { svg, detail };
}


/**
 * Detail-chart entry point - a thin wrapper delegating to `genericDetailChart`,
 * which renders PURELY from the declarative `meta.chart` spec (FXH / derived-kind /
 * generic single-axis layouts selected off the spec SHAPE, never `meta.id`). The
 * old bespoke per-id renderers and the id-cascade dispatch were deleted in Case 1
 * Stage 5 once the parity guard proved byte-for-byte equivalence; their
 * graceful-degrade (FXH `havenLegs`-absent fallback, null-decision gaps) now lives
 * in generic null-handling. Returns `{ svg, detail }` - `svg` the
 * chart markup, `detail` the pointer-readout seam the caller slots into `zoneD.details`.
 */
export function detailChart(meta, pts, eff, { compact = false, geo, window = null, redacted = false } = {}) {
  const g = geo ?? (compact ? COMPACT_CH : CH);
  const r = redacted ? ribbonOnlyChart(meta, pts, { compact, geo, window }) : genericDetailChart(meta, pts, eff, g, window);
  return withProxyShade(r, eff?.proxy, g);
}

/** /api/series `proxy` ({source, until}): shade the visible plot left of the first sample dated ≥ `until`
 *  (to the right edge if none) and tag each earlier sample's readout `· proxy (<source>)`. Unchanged when absent / off-window. */
export function withProxyShade(r, proxy, g = CH) {
  const until = proxy?.until;
  const samples = r.detail?.samples ?? [];
  if (typeof until !== "string" || typeof proxy.source !== "string" || !(samples[0]?.date < until)) return r;
  const join = samples.find((s) => s.date >= until);
  const x1 = join ? join.x : g.ml + plotW(g);
  const rect =
    `<rect data-proxy-until="${esc(until)}" x="${g.ml.toFixed(2)}" y="${g.mt}" width="${(x1 - g.ml).toFixed(2)}"` +
    ` height="${plotH(g).toFixed(2)}" fill="var(--ink-dim)" fill-opacity="0.12" pointer-events="none" />`;
  const svg = r.svg.replace(/<svg class="chart"[^>]*>/, (open) => `${open}${rect}`);
  const tag = ` · proxy (${proxy.source})`;
  const tagged = samples.map((s) => (s.date < until ? { ...s, readout: `${s.readout}${tag}` } : s));
  return { svg, detail: { ...r.detail, samples: tagged } };
}

/** R5: the ONE frame for a `redacted` /api/series payload (licensed id — points carry state only).
 *  State band + ribbon + dates, readout `date · STATE`; no level line, axis, cut, Δ or value chip. */
export function ribbonOnlyChart(meta, allPts, { compact = false, geo, window = null } = {}) {
  const g = geo ?? (compact ? COMPACT_CH : CH);
  // Real closes only (S4b): a stored estimate tail never enters the ribbon.
  const pts = allPts.slice(specWindowStart(allPts, meta.chart ?? {}, window)).filter((p) => p.estimated !== true);
  const n = pts.length;
  const body = (tail) => `${esc(meta.label ?? meta.id ?? "")} · state only - licensed data, values withheld · ${tail}`;
  if (n === 0) {
    const svg = `${chartOpen(chartTitle(meta), g, chartHead(meta))}${hoverLayer({ geo: g, chip: true })}
  </svg>
  ${caption(meta, g, body("no data"))}`;
    return { svg, detail: { n: 0, samples: [], staticYs: [] } };
  }
  const fillFor = meta.valueOnly ? () => "var(--ink-dim)" : null;
  const cellW = plotW(g) / n;
  const band = pts
    .map((p, i) => {
      const fill = (fillFor && fillFor(p)) || STATE_COLORS[p.state] || "var(--ink-dim)";
      return `<rect x="${(g.ml + i * cellW).toFixed(2)}" y="${g.mt}" width="${Math.ceil(cellW) + 0.5}" height="${plotH(g).toFixed(2)}" fill="${fill}" fill-opacity="0.22" pointer-events="none" />`;
    })
    .join("");
  const ribbon = stateRibbon(pts, (p) => (p.leg ? ` - via ${legPhrase(p.leg)}` : ""), fillFor, g);
  const samples = pts.map((p, i) => {
    const state = meta.valueOnly ? "" : (p.state ?? "");
    const mark = p.provisional === true ? " · INTRADAY" : "";
    return {
      date: p.date,
      x: xAt(i, n, g),
      dotY: null,
      ys: [],
      readout: `${p.date} · ${state || "unscored"}${mark}`,
      chip: chipText({ date: p.date, prim: null, sec: null, state }),
    };
  });
  const svg = `${chartOpen(chartTitle(meta), g, chartHead(meta))}
    ${band}${ribbon}${hoverLayer({ geo: g, chip: true })}${axisXDates(pts, g)}
  </svg>
  ${caption(meta, g, body("ribbon = state"))}`;
  return { svg, detail: { n, samples, staticYs: [] } };
}

/** Split a rendered chart block at its trailing `<p class="chart-legend">` so the compare
 *  stack can re-slot every legend below ALL charts; `chart + legend` recomposes byte-identically. */
export function splitLegend(svg) {
  const i = svg.lastIndexOf('<p class="chart-legend"');
  return i === -1 ? { chart: svg, legend: "" } : { chart: svg.slice(0, i), legend: svg.slice(i) };
}

/** Linked-crosshair pairing: nearest sample to ISO `date` (ties → earlier sample), or null
 *  when `date` falls outside the chart's own date-ascending [first, last] sample range. */

/** The travelling chip's whole content: compact date · the PRIMARY value token the readout leads
 *  with · the SECONDARY-axis line's value where one is drawn, then the state letter
 *  (`26-08-29 · 1.42 · 0.31 A`). `sec` is omitted — never blank-padded — on a single-axis chart or a
 *  null point, so the chip stays as narrow as the chart's own content allows; everything else
 *  (extra legs, gate state, trend overlays) stays in the docked strip. */
function chipText({ date, prim, sec, state, tail }) {
  const head = [compactDate(date), prim, sec].filter((t) => t != null && t !== "").join(" · ");
  const body = `${head} ${STATE_LETTER[state] ?? "?"}`;
  return tail ? `${body} · ${tail}` : body;
}

/** FX ids whose Δ readout also prints the Δ as a % of the `w`-ago close (window = the id's own
 *  `velocityWindow`), so a yen-unit Δ reads in %. The %-off-high figure rides F17's secondary axis. */
const FX_PCT_IDS = new Set(["F17"]);

export function fxPctTerms(pts, i, w) {
  const v = pts[i]?.value;
  if (!(typeof w === "number" && w >= 1) || !(typeof v === "number" && Number.isFinite(v))) return null;
  const base = i >= w ? pts[i - w]?.value : null;
  if (!(typeof base === "number" && base > 0)) return { chg: "n/a" };
  const x = v / base - 1;
  return { chg: `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%` };
}

/** Push `scale(v)` onto a sample's `ys` when `v` is a finite number and its scaled y is finite —
 *  the per-column occupancy of ONE drawn line, nulls/NaN dropped (S3 seam; S4's parking walk reads it). */
function pushY(ys, v, scale) {
  if (typeof v === "number" && Number.isFinite(v)) {
    const y = scale(v);
    if (Number.isFinite(y)) ys.push(y);
  }
}

export function sampleForDate(samples, date) {
  if (!samples?.length || date < samples[0].date || date > samples[samples.length - 1].date) return null;
  const t = Date.parse(date);
  let best = null;
  let bestDist = Infinity;
  for (const s of samples) {
    const dist = Math.abs(Date.parse(s.date) - t);
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}
