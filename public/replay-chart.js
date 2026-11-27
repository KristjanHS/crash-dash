// Historical-replay leg-path card (mode 2b) — pure HTML-string projection of the
// server-computed ReplayResponse (src/replay.ts / api/lab.ts `?replay=`). Learning
// view only: it draws WHAT YOU'D HOLD per trading day (the T1 target rung, or the
// R4 re-entry rung, or an off-scale cash lane while the breaker is tripped) plus
// the R4 overlay. NO verdict, NO benchmark line, NO return math — those belong to
// the live/scenario surfaces, not here.
//
// Kept OUT of lab.js (the scoreboard-card.js / tile-members.js seam idiom) so the
// no-jsdom vitest suite (replay-chart.test.js) can pin the exact markup with pure
// string assertions — this module touches no `document`/`window`/`localStorage`.
//
// Contract: replayChartHtml(resp, familyMembers) → the card's inner HTML.
//  - `resp`         : the ReplayResponse wire shape { mode, start, end, points[],
//                     coverage[], notes[] } (src/api/types.ts ReplayResponseDTO).
//  - `familyMembers`: [{ label, ids, state }] — lab.js derives it from the danger-model
//                     payload (globalFamilies → {label, ids:[member.id], state}); used to
//                     turn per-member `coverage.firstDate` into the per-FAMILY coverage
//                     timerange bar (one state-colored strip per family). Accepted as a
//                     param — this seam never fetches. Defaults to [] (no bar).
//  Empty/absent points → the honest "no history in range" placeholder card
//  (the deployed≠run empty-card class — same shape as scoreboard-card's warming card).

import { esc, hoverLayer } from "./chart-primitives.js";
import { sleeveLabel } from "./sleeve-label.js";

// The 9-leg ladder sleeve KEYS, rung 1 (aggressive) → rung 9 (Staples/defensive).
// Mirrors src/families.ts LADDER; kept local so this pure seam needs no server import
// (the wire only carries rung NUMBERS). If LADDER changes, this key list follows.
const LADDER_KEYS = [
  "Semis",
  "S&P IT",
  "EM",
  "Value",
  "S&P 500",
  "ex-US",
  "EU-Fin",
  "Health",
  "Staples",
];
/** The rendered names (axis ticks + hover readout), routed through the one label map. */
const LADDER_LABELS = LADDER_KEYS.map(sleeveLabel);

// ── SVG frame geometry (self-contained; wider left margin than the detail charts
//    for the sleeve-name y-labels, deeper bottom margin for the date ticks). ──────
const F = { w: 720, h: 280, ml: 88, mr: 16, mt: 16, mb: 44 };
const PW = F.w - F.ml - F.mr;
const PH = F.h - F.mt - F.mb;

// 10 rows: rungs 1..9 (slots 1..9) + an off-scale CASH lane (slot 10) BELOW Staples.
// Risk-down = visually down: rung 1 (Semis, aggressive) sits at the TOP, rung 9
// (Staples) near the bottom, cash lowest of all.
const CASH_SLOT = 10;
const N_ROWS = 10;
/** y (px) for a row slot 1..10 — slot 1 top, slot 10 (cash) bottom. */
const rowY = (slot) => F.mt + ((slot - 1) / (N_ROWS - 1)) * PH;
/** the held row for a point: cash → off-scale lane, else re-entry rung (what you'd
 *  actually hold while walking back in) falling back to the target rung. */
const holdSlot = (p) => (p.cash ? CASH_SLOT : p.reentryRung ?? p.targetRung);

/** Defensive-tail graded warm→danger classes (D6): the bottom four rows carry a warm
 *  hue that deepens with danger — EU-Fin amber → Health orange → Staples deep-orange →
 *  Cash deepest red — interpolated between the lab `--elev`/`--danger` tokens in styles.css.
 *  The upper six rungs (slots 1–6, Semis…ex-US) get no class and keep the neutral/cool ink.
 *  One class per row, reused on BOTH the step-path stroke and its ladder tick label. */
const WARM_BY_SLOT = { 7: "rp-warm-1", 8: "rp-warm-2", 9: "rp-warm-3", [CASH_SLOT]: "rp-warm-4" };
const warmClass = (slot) => (WARM_BY_SLOT[slot] ? " " + WARM_BY_SLOT[slot] : "");

/** left/right x (px) of the band for day i of n (one x-step per trading day — no
 *  interpolation across missing calendar days). */
const bandL = (i, n) => F.ml + (i / n) * PW;
const bandR = (i, n) => F.ml + ((i + 1) / n) * PW;
const bandC = (i, n) => (bandL(i, n) + bandR(i, n)) / 2;

/** ~6 evenly-spaced day indices for the sparse date axis (always includes the last).
 *  The end-of-range tick EVICTS the last regular tick when they'd land within ~0.7
 *  step of each other — else two date labels at near-identical x paint as one doubled,
 *  unreadable smudge at the right edge (D5a; the exposure-replay-chart tickIndices fix). */
function tickIndices(n) {
  if (n <= 1) return [0];
  const step = Math.max(1, Math.floor(n / 6));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) {
    if (n - 1 - idx[idx.length - 1] < step * 0.7) idx.pop();
    idx.push(n - 1);
  }
  return idx;
}

/** Contiguous runs of cash days → [startIdx, endIdx] inclusive, for the shaded bands. */
function cashRuns(points) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i].cash) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, points.length - 1]);
  return runs;
}

/** The honest empty card (no stored closes in range) — the deployed≠run empty-card
 *  class; mirrors scoreboard-card's warming card (title + one honest line, nothing else). */
function emptyCard(start, end) {
  const range = start && end ? ` for ${esc(start)} → ${esc(end)}` : "";
  return (
    `<div class="rp-head"><h2 class="rp-title">Historical replay</h2></div>` +
    `<p class="rp-warming">no history in range - no stored closes${range}. ` +
    `Backfill the store (or widen the range) to draw a leg-path.</p>`
  );
}

// ── Coverage timerange bar (D7) — replaces the old chip pile. One thin strip per
//    family under a shared calendar axis spanning the replay range: a faint/hatched
//    leading segment for the late-start (uncovered) span, then a solid state-colored
//    fill from the family's earliest covered-member firstDate to end-of-range. The
//    wire carries ONLY firstDate per member (no lastDate, no mid-series gaps), so the
//    bar is honest start→end coverage — it never invents gap segments. ──────────────
const CB_STATE_CLASS = { GREEN: "rp-cov-g", AMBER: "rp-cov-a", RED: "rp-cov-r" };
const CB = { w: 720, ml: 88, mr: 16, mt: 6, rowH: 9, rowGap: 5, mb: 16 };
const CBW = CB.w - CB.ml - CB.mr;
const cbT = (d) => Date.parse(d + "T00:00:00Z");

/** Year-boundary ticks (Jan-1s inside the range) → [{x, label}]; falls back to the
 *  range endpoints when the window is under a year (no interior boundary to label). */
function coverageTicks(start, end, x) {
  const y0 = Number(start.slice(0, 4));
  const y1 = Number(end.slice(0, 4));
  const t0 = cbT(start);
  const t1 = cbT(end);
  const ticks = [];
  for (let y = y0 + 1; y <= y1; y++) {
    const t = cbT(`${y}-01-01`);
    if (t > t0 && t < t1) ticks.push({ x: x(`${y}-01-01`), label: String(y) });
  }
  if (ticks.length === 0) {
    return [
      { x: x(start), label: start, anchor: "start" },
      { x: x(end), label: end, anchor: "end" },
    ];
  }
  return ticks.map((t) => ({ ...t, anchor: "middle" }));
}

/** Per-family coverage strips: each family's earliest covered-member firstDate (min over
 *  its members) opens its solid state-colored strip; the pre-firstDate span reads as a
 *  faint hatched track; all-null members → an all-hatched "no history" row. Strip color
 *  follows the family's live/scenario state (carried on each familyMembers entry). */
function coverageBar(coverage, familyMembers, start, end) {
  if (!familyMembers || familyMembers.length === 0 || !start || !end) return "";
  const t0 = cbT(start);
  const t1 = cbT(end);
  const span = t1 - t0 || 1;
  const x = (d) => CB.ml + Math.min(1, Math.max(0, (cbT(d) - t0) / span)) * CBW;
  const firstById = new Map((coverage || []).map((c) => [c.id, c.firstDate]));

  const n = familyMembers.length;
  const h = CB.mt + n * CB.rowH + (n - 1) * CB.rowGap + CB.mb;
  const xR = CB.ml + CBW;

  let rows = "";
  familyMembers.forEach((fam, i) => {
    let earliest = null;
    for (const id of fam.ids || []) {
      const d = firstById.get(id);
      if (d && (earliest === null || d < earliest)) earliest = d;
    }
    const y = CB.mt + i * (CB.rowH + CB.rowGap);
    const covL = earliest ? x(earliest) : xR; // no history → fill starts at the right edge (empty)
    const stateCls = CB_STATE_CLASS[fam.state] || "";
    const title = earliest ? `${fam.label}: covered from ${earliest}` : `${fam.label}: no history`;
    rows +=
      `<text class="rp-cov-label" x="${(CB.ml - 6).toFixed(1)}" y="${(y + CB.rowH - 1).toFixed(1)}" text-anchor="end">${esc(fam.label)}</text>` +
      // faint hatched track = the uncovered (late-start) leading span across the whole row
      `<rect class="rp-cov-gap" x="${CB.ml}" y="${y.toFixed(1)}" width="${CBW.toFixed(1)}" height="${CB.rowH}"><title>${esc(title)}</title></rect>` +
      // solid state-colored fill from firstDate → end-of-range
      (earliest
        ? `<rect class="rp-cov-fill ${stateCls}" x="${covL.toFixed(1)}" y="${y.toFixed(1)}" width="${(xR - covL).toFixed(1)}" height="${CB.rowH}"><title>${esc(title)}</title></rect>`
        : "");
  });

  const axisY = CB.mt + n * CB.rowH + (n - 1) * CB.rowGap + 4;
  const ticks = coverageTicks(start, end, x)
    .map(
      (t) =>
        `<line class="rp-cov-tick" x1="${t.x.toFixed(1)}" y1="${CB.mt.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${axisY.toFixed(1)}" />` +
        `<text class="rp-cov-ticklabel" x="${t.x.toFixed(1)}" y="${(axisY + 10).toFixed(1)}" text-anchor="${t.anchor}">${esc(t.label)}</text>`,
    )
    .join("");

  return (
    `<svg class="rp-covbar" viewBox="0 0 ${CB.w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="Per-family data coverage across the replay range">` +
    // diagonal hatch marking the uncovered late-start span (░), theme-token stroked
    `<defs><pattern id="rpCovHatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
    `<line class="rp-cov-hatchline" x1="0" y1="0" x2="0" y2="4" /></pattern></defs>` +
    rows +
    ticks +
    `</svg>`
  );
}

/**
 * The whole replay card's inner HTML. Empty/absent points → the honest placeholder.
 * Everything is precomputed server-side — this seam only positions marks and echoes
 * `notes` verbatim; no engine math, no re-scoring.
 */
export function replayChartHtml(resp, familyMembers = []) {
  const start = resp && resp.start;
  const end = resp && resp.end;
  const points = (resp && resp.points) || [];
  if (points.length === 0) return emptyCard(start, end);

  const n = points.length;

  // --- y-axis: faint rung gridlines + sleeve-name labels (rung 1 top … cash lane). ---
  let axis = "";
  for (let slot = 1; slot <= N_ROWS; slot++) {
    const y = rowY(slot);
    const label = slot === CASH_SLOT ? "Cash" : LADDER_LABELS[slot - 1];
    axis +=
      `<line class="rp-grid" x1="${F.ml}" y1="${y.toFixed(1)}" x2="${(F.ml + PW).toFixed(1)}" y2="${y.toFixed(1)}" />` +
      `<text class="rp-ylabel${warmClass(slot)}" x="${(F.ml - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(label)}</text>`;
  }
  // Left-axis title (D3): the sleeve names above ARE the ladder axis's tick values; this
  // names the axis itself so it reads as an axis, not a bare label stack — mirrors the
  // exposure-replay-chart IEF/companion axis-title idiom (one title at the top of the axis
  // column, text-anchor end at the tick column x). The right IEF axis there carries both;
  // this brings the left ladder axis to parity.
  axis += `<text class="rp-yaxis-title" x="${(F.ml - 6).toFixed(1)}" y="${(F.mt - 4).toFixed(1)}" text-anchor="end">Held leg</text>`;

  // --- R4 cash bands: one shaded rect per contiguous cash run. ---
  const bands = cashRuns(points)
    .map(([s, e]) => {
      const x = bandL(s, n);
      const w = bandR(e, n) - x;
      return `<rect class="rp-cash-band" x="${x.toFixed(1)}" y="${F.mt}" width="${w.toFixed(1)}" height="${PH.toFixed(1)}" />`;
    })
    .join("");

  // --- Step-line: one horizontal <path> per trading day (what you'd hold that day);
  //     reentry-phase days get a distinct dashed stroke. Vertical risers connect
  //     consecutive days where the held row changes (not counted as step segments). ---
  let steps = "";
  let risers = "";
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const slot = holdSlot(p);
    const y = rowY(slot).toFixed(1);
    const xL = bandL(i, n).toFixed(1);
    const xR = bandR(i, n).toFixed(1);
    const reentry = p.r4Phase === "reentry";
    steps += `<path class="rp-step${reentry ? " rp-reentry" : ""}${warmClass(slot)}" d="M${xL} ${y} L${xR} ${y}" />`;
    if (i > 0) {
      const yPrev = rowY(holdSlot(points[i - 1]));
      const yCur = rowY(holdSlot(p));
      if (yPrev !== yCur) {
        risers += `<path class="rp-riser" d="M${xL} ${yPrev.toFixed(1)} L${xL} ${yCur.toFixed(1)}" />`;
      }
    }
  }

  // --- x-axis: ~6 sparse date ticks, at the band centre (trading-day axis). ---
  const ticks = tickIndices(n)
    .map((i) => {
      const cx = bandC(i, n).toFixed(1);
      return (
        `<text class="rp-xlabel" x="${cx}" y="${(F.h - 12).toFixed(1)}" text-anchor="middle">${esc(points[i].date)}</text>`
      );
    })
    .join("");

  // --- per-day crosshair payload (data-hover, D5b): readout precomputed HERE so lab.js stays
  //     pure DOM wiring (no chart math client-side). x/y in SVG user units; the frame fields
  //     letterbox-correct pointer x without importing F. The dot sits on the held-leg step y.
  //     (The exposure-replay-chart hoverDays idiom; this chart carries no price/IEF series, so
  //     `ief` is echoed only WHERE PRESENT — future-proofing, absent in today's ReplayPoint.) ---
  const hoverDays = points.map((p, i) => {
    const slot = holdSlot(p);
    const held = p.cash ? "Cash" : LADDER_LABELS[slot - 1];
    const parts = [
      p.date,
      held,
      ...(p.r4Phase === "reentry" ? ["re-entry"] : []),
      ...(p.ief != null ? [`IEF ${p.ief.toFixed(2)}`] : []),
    ];
    return {
      d: p.date,
      x: Number(bandC(i, n).toFixed(1)),
      y: Number(rowY(slot).toFixed(1)),
      r: parts.join(" · "),
    };
  });
  const hoverData = { w: F.w, h: F.h, ml: F.ml, pw: PW, days: hoverDays };

  const svg =
    `<svg class="rp-chart" viewBox="0 0 ${F.w} ${F.h}" width="100%" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" ` +
    `data-hover="${esc(JSON.stringify(hoverData))}" ` +
    `aria-label="Historical replay: held ladder leg per trading day, ${esc(start || "")} to ${esc(end || "")}">` +
    axis +
    bands +
    risers +
    steps +
    ticks +
    // Crosshair spans the full leg-path plot (D5b): a vertical line + a dot on the held-leg
    // step + a date/held-leg readout, positioned by lab.js from the data-hover payload above.
    hoverLayer({ top: F.mt, height: PH }) +
    `</svg>`;

  const head =
    `<div class="rp-head"><h2 class="rp-title">Historical replay</h2>` +
    `<span class="rp-sub">held leg per trading day${start && end ? ` · ${esc(start)} → ${esc(end)}` : ""}</span></div>`;

  // Footer: server notes VERBATIM + the per-family coverage timerange bar. No verdict/return math.
  const notes = ((resp && resp.notes) || [])
    .map((t) => `<p class="rp-note">${esc(t)}</p>`)
    .join("");
  const footer = `<div class="rp-footer">${coverageBar(resp && resp.coverage, familyMembers, start, end)}${notes ? `<div class="rp-notes">${notes}</div>` : ""}</div>`;

  return head + svg + footer;
}
