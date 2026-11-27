// D9 live scoreboard — pure HTML projection of the server-computed ScoreboardView
// (src/scoreboard.ts, attached to the /api/lab LIVE response as `scoreboard`).
// Kept OUT of lab.js so the no-jsdom vitest suite (lab.scoreboard.test.js) can pin the
// exact markup lab.js paints — the same seam pattern as tile-members.js / format.js.
// Display projection ONLY: no metric math, no gate logic — every number/verdict/label
// arrives precomputed (indicator read-time re-scoring stays forbidden).
//
// Contract: scoreboardCardHtml(sb) returns the card's inner HTML, or null when the
// response carries no scoreboard field (scenario mode / a stale pre-scoreboard payload)
// — lab.js's renderScoreboard hides the whole section on null.

// One escaper for the whole front-end: chart-primitives.js's `esc` (it alone also escapes `'`).
import { esc } from "./chart-primitives.js";
import { secTip } from "./section-tips.js";

/** One MetricCell → HTML: the formatted value, or the honest `n/a yet` (server reason on [title]). */
function cellHtml(cell, fmt) {
  if (!cell || cell.value === null || cell.value === undefined) {
    const reason = (cell && cell.naReason) || "n/a yet";
    return `<span class="sb-na" title="${esc(reason)}">n/a yet</span>`;
  }
  return `<b>${esc(fmt(cell.value))}</b>`;
}

const f2 = (v) => v.toFixed(2);
const pct1 = (v) => `${v.toFixed(1)}%`;
const runsFmt = (v) => `${v} runs`;

/** PASS/FAIL pill; null verdict = the gate's own honest `n/a`. */
function badge(verdict) {
  if (verdict === "PASS") return '<span class="sb-badge pass">PASS</span>';
  if (verdict === "FAIL") return '<span class="sb-badge fail">FAIL</span>';
  return '<span class="sb-badge na">n/a</span>';
}

/** Gate (a) — ulcer: BOTH numbers + its own verdict pill, never a ratio/combined figure. */
function ulcerGateHtml(g) {
  const s = g.strategyUi === null ? "-" : g.strategyUi.toFixed(2);
  const b = g.benchmarkUi === null ? "-" : g.benchmarkUi.toFixed(2);
  const na = g.verdict === null ? ` <span class="sb-na">${esc(g.naReason || "n/a yet")}</span>` : "";
  return (
    `<div class="sb-gate" data-gate="ulcer">` +
    `<span class="sb-gate-name">gate (a) · ulcer index</span>` +
    `<span class="sb-gate-read">strategy <b>${esc(s)}</b> vs yardstick <b>${esc(b)}</b>${na}</span>` +
    badge(g.verdict) +
    `</div>`
  );
}

/** Gate (b) — overrides: count vs the B1 budget + its own verdict pill (visually separate row). */
function overridesGateHtml(g) {
  return (
    `<div class="sb-gate" data-gate="overrides">` +
    `<span class="sb-gate-name">gate (b) · overrides (12 mo)</span>` +
    `<span class="sb-gate-read"><b>${esc(String(g.count))}</b>/${esc(String(g.limit))} recorded</span>` +
    badge(g.verdict) +
    `</div>`
  );
}

/** Metrics strip: maxDD / Calmar / recovery, strategy vs yardstick columns. */
function metricsTableHtml(s, b) {
  const row = (label, key, fmt) =>
    `<tr><th>${label}</th><td>${cellHtml(s[key], fmt)}</td><td>${cellHtml(b[key], fmt)}</td></tr>`;
  return (
    `<div class="sb-metrics-wrap"><table class="sb-metrics">` +
    `<thead><tr><th></th><th>strategy</th><th>yardstick</th></tr></thead><tbody>` +
    row("max drawdown", "maxDD", pct1) +
    row("Calmar", "calmar", f2) +
    row("recovery", "recoveryRuns", runsFmt) +
    `</tbody></table></div>`
  );
}

/** Watched guardrails line (displayed, not gates): return-vs-fund + M2 flag chip + time-in-cash. */
function guardHtml(sb) {
  const ret =
    sb.returnVsFundPp === null
      ? '<span class="sb-na">n/a yet</span>'
      : `<b>${esc(`${sb.returnVsFundPp >= 0 ? "+" : ""}${sb.returnVsFundPp.toFixed(2)} pp/yr`)}</b>`;
  const flag = sb.returnFlag
    ? ` <span class="sb-flag ${sb.returnFlag === "RETUNE" ? "retune" : "kill"}">${esc(sb.returnFlag)}</span>`
    : "";
  const cash =
    sb.timeInCashShare === null
      ? '<span class="sb-na">n/a yet</span>'
      : `<b>${esc(`${(sb.timeInCashShare * 100).toFixed(0)}%`)}</b>`;
  return (
    `<p class="sb-guard">return vs fund ${ret}${flag}` +
    ` <span class="sep">·</span> time in cash ${cash}</p>`
  );
}

/**
 * The whole card, or null when the payload has no scoreboard (scenario mode — section absent).
 * Warming up (zero SB rows) → the honest empty card: warming line + both gate rows (gate (a)
 * n/a, gate (b) is override-backed so it is real from day 0) + the verbatim yardstick label;
 * no metrics strip / guardrails (every cell would be n/a). Never crashes on the empty shape.
 */
export function scoreboardCardHtml(sb) {
  if (!sb) return null;
  const head =
    `<div class="sb-head"><h2 class="sb-title sec-tip"${secTip("scoreboard")}>Scoreboard</h2>` +
    `<span class="sb-note">two gates, read separately · informs the D7 kill read - never auto-decides</span></div>`;
  const gates = `<div class="sb-gates">${ulcerGateHtml(sb.gates.ulcer)}${overridesGateHtml(sb.gates.overrides)}</div>`;
  const yard = `<p class="sb-yardstick">${esc(sb.yardstickLabel)}</p>`;
  if (sb.warmingUp) {
    const warm =
      `<p class="sb-warming">warming up - no scoreboard runs recorded yet; ` +
      `metrics appear after the first cron run.</p>`;
    return head + warm + gates + yard;
  }
  return (
    head +
    `<p class="sb-window">${esc(sb.windowStatement)}</p>` +
    gates +
    metricsTableHtml(sb.strategy, sb.benchmark) +
    guardHtml(sb) +
    yard
  );
}
