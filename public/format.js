// Display-format island split out of app.js so it unit-tests without a DOM
// (mirrors haven-envelope.js / ladder-chart.js — plain `.js` so vitest collects it and
// `tsc` ignores it). Pure string/data building: signed deltas, pension-percent,
// slow-leg metric text, latest-point extraction, and the what-if badge. Zero DOM
// access, zero module-level side effects. `esc` is imported from chart-primitives.js.

import { esc } from "./chart-primitives.js";

/**
 * The what-if badge. Driven by the server's ECHOED applied multiplier (`series.mult`), NEVER by
 * MULT or the URL — so a `?mult=0.1` the client snapped to the 0.5 grid edge badges the 0.5
 * actually applied (the server 400s anything off-grid, so the echo is always a grid value), config-override
 * (non-URL) ribbons stay unbadged (config is the real engine, not a what-if), and a payload the
 * what-if never reached (degraded proxy) renders no badge at all.
 */
export function whatIfBadge(appliedMult) {
  if (!(appliedMult > 0)) return "";
  return `<p class="whatif-note"><span class="badge badge-whatif" title="Display-only: bands + ribbon shift, cards/alerts unchanged. The ribbon recolours cell-by-cell off the raw state (no confirmation buffer), so a shifted band shows up the same day.">what-if ×${esc(String(appliedMult))}</span>
    threshold multiplier applied - bands + ribbon only. Cards, alert level and notifications are unchanged.</p>`;
}

/** Δ20 is always signed; magnitude is 2 dp for `%`, else ~2 sig figs; `mode` "relative" = a fraction ⇒ 1-dp %. */
export function formatDelta(delta, unit, mode) {
  if (delta == null) return "";
  if (mode === "relative") return `${delta >= 0 ? "+" : "-"}${(Math.abs(delta) * 100).toFixed(1)}%`;
  const sign = delta >= 0 ? "+" : "-";
  const mag = Math.abs(delta);
  const body =
    unit === "%" ? mag.toFixed(2) : mag.toLocaleString(undefined, { maximumSignificantDigits: 2 });
  return `${sign}${body}`;
}

// EUR drawdown as a signed percent with a Unicode minus (U+2212). Drawdowns are ≤0 fractions
// (e.g. -0.123 → "−12.3%"); null → em dash. Display-only — tolerant of a
// non-negative input (won't fail-loud like the notify `pct()` helper).
export function pensionPct(dd) {
  if (dd == null) return "-";
  return `−${Math.abs(dd * 100).toFixed(1)}%`;
}

/** ETF card window return (`/api/status` `return20d`, a fraction): signed 1-dp percent, U+2212 minus; null → "-". */
export function windowReturnPct(r) {
  if (r == null) return "-";
  const pct = Number((r * 100).toFixed(1));
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(1)}%`;
}

/** Latest point's value from a /series payload, or null when absent. */
export function latestValue(series) {
  const pts = series?.points;
  return pts && pts.length ? pts[pts.length - 1].value : null;
}

/** Display the continuous leg metric (percentile / fraction ∈ [0,1]); null → em dash. */
export function slowMetricVal(metric) {
  return metric == null ? "-" : metric.toFixed(2);
}
