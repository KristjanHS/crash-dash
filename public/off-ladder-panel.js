// Pure string builders for the two off-ladder panels (VIX-bottom /
// bubble-state) — verdict banners only, no leg cards. Zero DOM, zero module-level
// side effects — the DOM-impure shells (els.*, setHTML, the async /series pull,
// the slow stale-render guard) stay in app.js.
//
// Data flow: each builder takes the verdict/band data + { legend, meta } where
// `legend` is the LEGEND.* title text (LEGEND stays in app.js) and `meta` is the
// resolved *_META entry (constants live in off-ladder-specs.js) — `!meta` selects
// the muted branch. Template-literal indentation is a characterization contract
// pinned by off-ladder-panel.test.js — do not tidy it.
import { esc } from "./chart-primitives.js";
import { slowMetricVal } from "./format.js";

// Shared skeleton for all three off-ladder panels. `meta` (the resolved *_META
// entry) selects active-vs-muted; `classPrefix` supplies the per-panel CSS
// vocabulary (`bottom-`/`pension-`/`slow-` label/sub/head/frame class names —
// load-bearing `public/style` selectors, parameterized, never unified). Panel
// divergences map to params:
//   • `headerExtra` — pension's `headDd` blended-drawdown span. When threaded
//     (any string, INCLUDING ""), the panel renders the `-head` wrapper in the
//     muted branch too (bottom/slow omit `headerExtra` → bare label, no wrapper)
//     and appends the extra after the frame line in the active branch. The
//     empty-string case still emits the exactly-8-spaces line the tests pin.
//   • `footerExtra` — slow's `slow-score` + `slow-metrics` lines. Rendered in
//     BOTH branches (active and muted): CALM is the common state, and hiding the
//     score+metrics there would make the track unreadable exactly when it is quiet.
//   • `mutedLabel` / `mutedNote` / `frameText` — the per-panel static copy.
// Sync/pure: callers await any /series before invoking.
export function renderOffLadderPanel({
  classPrefix,
  meta,
  legend,
  mutedLabel,
  mutedNote,
  frameText,
  headerExtra,
  footerExtra,
}) {
  const p = classPrefix;
  const title = esc(legend);
  const hasHead = headerExtra != null; // pension threads a (possibly empty) headerExtra → head wrapper even when muted

  // The zone tooltip rides the LABEL, not the panel div: a whole-panel title turns every
  // tap in the zone into a help tap, hostile to scrolling. The panel div carries no [title].
  let header;
  if (meta) {
    const extraLine = hasHead ? `\n        ${headerExtra}` : "";
    header = `\n      <div class="${p}-head">
        <span class="${p}-label" title="${title}">${esc(meta.label)}</span>
        <span class="${p}-frame">${frameText}</span>${extraLine}
      </div>`;
  } else if (hasHead) {
    header = `\n      <div class="${p}-head">
        <span class="${p}-label" title="${title}">${mutedLabel}</span>
        ${headerExtra}
      </div>`;
  } else {
    header = `\n      <span class="${p}-label" title="${title}">${mutedLabel}</span>`;
  }

  const subText = meta ? meta.sub : mutedNote;
  const footer = footerExtra != null ? `\n      ${footerExtra}` : "";

  return `<div class="${p}-panel ${meta ? meta.cls : `${p}-muted`}">${header}
      <span class="${p}-sub">${esc(subText)}</span>${footer}
    </div>`;
}

// VIX-bottom panel. `verdict` supplies bottomState (→ muted note); `meta` is
// BOTTOM_META[state] (undefined → muted). Verdict banner only — the VIX / VIX3M
// legs render as Zone-C cards (family "Volatility"), so the panel no longer
// duplicates them.
export function bottomPanelHTML(verdict, { legend, meta }) {
  const state = verdict.bottomState ?? null;
  const mutedNote = state === "CALM" ? "calm - no capitulation signal." : "signal unavailable (VIX feed).";
  return renderOffLadderPanel({
    classPrefix: "bottom",
    meta,
    legend,
    mutedLabel: "VIX bottom watch",
    mutedNote,
    frameText: "Fear may be peaking - downside risk remains.",
  });
}

/**
 * The continuous per-leg metric line — `price-accel 0.85 · complacency-vix 0.05 ·
 * complacency-high 0.99`. The score alone is a 0-4 integer; the metrics are what makes
 * the bubble read informative. Values are the latest /series points, formatted by the shared
 * `slowMetricVal` (null → em dash) — the FE never re-derives a metric.
 * The score's denominator is NOT the count of legs quoted here — complacency-duration
 * scores without a continuous /series metric, so the metric line is one leg short of
 * the scored set. It comes from the server (`verdict.slowMaxScore`), never from a
 * count taken on this line.
 */
export function slowMetricsText({ accelM, cvixM, chighM }) {
  return [
    `price-accel ${slowMetricVal(accelM)}`,
    `complacency-vix ${slowMetricVal(cvixM)}`,
    `complacency-high ${slowMetricVal(chighM)}`,
  ].join(" · ");
}

// Bubble-state (slow) panel. Owns the `slow-score` + `slow-metrics` footer lines.
// `band`/`score`/`maxScore` ride on /status (verdict.slowBand/slowScore/slowMaxScore),
// `metrics` are the caller's /series latests; `meta` is SLOW_BAND_META[band]. Caller
// (renderZoneSlow) already awaited its /series and passed the stale-render guard.
//
// OFF-2: `maxScore` is the SERVER's denominator for THIS run (2 × activeCount, src/slow.ts) —
// never a constant here, because the active-indicator count is a rollout variable. It is null on
// a degraded slow run and on rows written before it was persisted; both render an em dash, so an
// unknown denominator reads as unknown instead of as a stale 4.
export function slowPanelHTML({ band, score, maxScore, metrics }, { legend, meta }) {
  const mutedNote = band === "CALM" ? "calm - no bubble-state signal." : "signal unavailable (slow feed).";
  const metricLine = metrics
    ? `\n      <span class="slow-metrics">${esc(slowMetricsText(metrics))}</span>`
    : "";
  return renderOffLadderPanel({
    classPrefix: "slow",
    meta,
    legend,
    mutedLabel: "Bubble-state watch",
    mutedNote,
    frameText: "Bubble fuel - not a crash call.",
    footerExtra: `<span class="slow-score">score ${Number.isFinite(score) ? score : "-"} / ${Number.isFinite(maxScore) ? maxScore : "-"}</span>${metricLine}`,
  });
}
