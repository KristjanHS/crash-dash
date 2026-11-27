/*
 * ladder-chart.js — the Zone D "Alert ladder" chart, extracted from app.js so it is
 * unit-testable in Node/vitest (no jsdom), the same seam pattern as detail-chart.js.
 *
 * It returns `{ svg, detail }` — the SAME shape every detail chart returns — so the ladder
 * joins the shared pointer-readout machinery in app.js instead of relying on per-dot
 * `<title>` tooltips (desktop-hover-only, invisible under a finger). `detail` is the
 * `{ n, samples, staticYs }` app.js slots into `zoneD.details`; `onScrub` then paints the
 * crosshair + travelling chip + the one viewport-pinned `#hover-bar` exactly as it does on
 * the detail tab. Nothing here touches `document`/`window`.
 *
 * Geometry note: the ladder draws on the plain `CH` frame (no state ribbon), so the chip's
 * floor park (`parkY`, chart-primitives.js) lands just above where a ribbon would be — the
 * same stable floor the detail charts use, so the readout doesn't jump under a scrubbing finger.
 */

import { ALERT_COLORS, CH, chartOpen, compactDate, esc, hoverLayer, plotW, xAt, yAt } from "./chart-primitives.js";

/**
 * Stepped line (step-after), y = alert level; dots mark runs that pushed.
 *
 * `alerts` is /api/history NEWEST-first (reversed here to draw oldest→newest); `cfg` is
 * /api/config, whose `alertRank` maps each AlertLevel to its rung — the rung order and the
 * rung COUNT both come from there, never from a hardcoded ladder here.
 */
export function ladderChart(alerts, cfg, geo = CH) {
  const rank = cfg.alertRank; // AlertLevel → 0..N, from /api/config (ladder.ts)
  const ladder = Object.keys(rank).sort((a, b) => rank[a] - rank[b]); // low→high
  const maxRank = Math.max(...Object.values(rank));
  const rows = [...alerts].reverse(); // API is newest-first; draw oldest→newest
  const n = rows.length;
  const rankY = (level) => yAt(rank[level] ?? 0, 0, maxRank, geo);
  const pw = plotW(geo);

  // y gridlines + labels, one per rung. They are STATIC horizontal lines, so their y's ride
  // `detail.staticYs`: the chip's parking walk steps out of the way of a rung line it would
  // otherwise sit on top of (app.js `paintChip`).
  const staticYs = ladder.map(rankY);
  const grid = ladder
    .map((lvl) => {
      const y = rankY(lvl);
      return `<line class="grid" x1="${geo.ml}" y1="${y}" x2="${geo.ml + pw}" y2="${y}" />
      <text class="axis-y" x="${geo.ml - 8}" y="${y + 3}">${lvl}</text>`;
    })
    .join("");

  // Stepped path: hold each level until the next sample, then jump.
  let d = "";
  rows.forEach((r, i) => {
    const x = xAt(i, n, geo);
    const y = rankY(r.level);
    if (i === 0) d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
    else d += ` L${x.toFixed(1)} ${rankY(rows[i - 1].level).toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)}`;
  });

  // Dots: every run faint; runs that actually pushed get a filled, ringed dot. The `<title>`s
  // stay — they are the accessible name of each point, and the crosshair readout is a hover
  // affordance layered over them, not a replacement.
  const dots = rows
    .map((r, i) => {
      const x = xAt(i, n, geo).toFixed(1);
      const y = rankY(r.level).toFixed(1);
      const color = ALERT_COLORS[r.level];
      if (r.pushedAt)
        return `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="var(--bg)" stroke-width="1"><title>${esc(r.date)} ${esc(r.level)} · pushed</title></circle>`;
      return `<circle cx="${x}" cy="${y}" r="1.6" fill="var(--ink-dim)"><title>${esc(r.date)} ${esc(r.level)} · silent</title></circle>`;
    })
    .join("");

  // One sample per run — the ladder's step IS its value, so the readout carries the level
  // (not a number) plus whether that run pushed. `dotY` is always finite: a history row always
  // carries a level, and an unknown level degrades to rung 0 rather than a gap.
  const samples = rows.map((r, i) => {
    const y = rankY(r.level);
    const push = r.pushedAt ? "pushed" : "silent";
    return {
      date: r.date,
      x: xAt(i, n, geo),
      dotY: y,
      ys: [y],
      readout: `${r.date} · ${r.level} · ${push} run`,
      chip: `${compactDate(r.date)} · ${r.level}${r.pushedAt ? " ●" : ""}`,
    };
  });

  const xLabels = `
    <text class="axis-x" x="${geo.ml}" y="${geo.h - 8}" text-anchor="start">${esc(rows[0].date)}</text>
    <text class="axis-x" x="${geo.ml + pw}" y="${geo.h - 8}" text-anchor="end">${esc(rows[n - 1].date)}</text>`;

  const svg = `${chartOpen("Alert-ladder history", geo)}
    ${grid}
    <path class="line" d="${d}" fill="none" stroke="var(--ink)" stroke-width="1.5" />
    ${dots}${hoverLayer({ geo, chip: true })}${xLabels}
  </svg>
  <p class="chart-legend"><span class="dot-pushed"></span> pushed &nbsp; <span class="dot-silent"></span> silent run · ${n} run${n === 1 ? "" : "s"}</p>`;

  return { svg, detail: { n, samples, staticYs } };
}
