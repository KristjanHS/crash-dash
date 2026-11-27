// Episode-replay chart (Slice E2) — pure HTML-string projection of ONE episode from
// the server-computed /api/replay payload. Learning view only: it draws the exposure
// dial (computeExposure → ARM credit key + FIRE trend key → Full/Core/Reduced/Defensive)
// replayed across a historical crisis window. NO engine math, NO scoring, NO verdict —
// this seam only positions marks and echoes the server's per-day fields.
//
// Kept OUT of lab.js (the replay-chart.js / scoreboard-card.js seam idiom) so the
// no-jsdom vitest suite (exposure-replay-chart.test.js) can pin the exact markup with
// plain string assertions — this module touches no `document`/`window`/`localStorage`.
//
// Wire shape (src/api/types.ts, /api/replay):
//   episode: { id, label, start, end, candidate, rationale,
//              points:  [{ date, price, armed, fired, posture, degraded }],
//              defensive?: [{ date, price }],   // IEF bond-rung proxy, faint 2nd line
//              notes: [] }
//   posture ∈ "Full" | "Core" | "Reduced" | "Defensive", null when degraded.
//   A `redacted` body (licensed data) nulls every `price`: those lines paint as
//   absent with a "withheld" legend key; lanes still draw. A `redacted` companion likewise.
// Degraded days render as GAPS in every lane — never a fabricated Core.

import { esc, formatValue, hoverLayer } from "./chart-primitives.js";
import { floorMonthStart, ceilMonthStart } from "./month-grid.js";

// ── SVG frame geometry (self-contained). Top: price/defensive line panel.
//    Bottom: three stacked state lanes (ARM · FIRE · Posture). ──────────────────
const F = { w: 720, h: 340, ml: 60, mr: 48, mt: 16, mb: 34 };
const PW = F.w - F.ml - F.mr;
const PRICE_H = 150; // price panel height
const LANE_H = 22;
const LANE_GAP = 8;
const LANE_LABELS = ["ARM", "FIRE", "Posture"];
const LANE_TOP = F.mt + PRICE_H + 26; // first lane's top y
const PRICE_TOP = F.mt;

/** left/right x (px) of the band for day i of n — one x-step per trading day, no
 *  interpolation across missing calendar days (the replay-chart.js band idiom). */
const bandL = (i, n) => F.ml + (i / n) * PW;
const bandR = (i, n) => F.ml + ((i + 1) / n) * PW;
const bandC = (i, n) => (bandL(i, n) + bandR(i, n)) / 2;

/** top y of lane row r (0 = ARM, 1 = FIRE, 2 = Posture). */
const laneY = (r) => LANE_TOP + r * (LANE_H + LANE_GAP);

/** Posture value → CSS slug (the exposure-view.js tone idiom). A MIRROR of `Posture` in
 *  src/exposure.ts; `exposure-replay-chart.test.js` imports `EQUITY_PCT` and asserts key-set
 *  equality in BOTH directions, so an upstream posture added (which the `|| "core"` fallback
 *  below would otherwise paint as Core) or removed goes red. Exported for that test only. */
export const POSTURE_SLUG = {
  Full: "full",
  Core: "core",
  Reduced: "reduced",
  Defensive: "defensive",
};

/** Legend suffix + footnote for a line whose raw values the server withheld. */
const withheld = (on) => (on ? " - withheld" : "");
const WITHHELD_NOTE = "Price lines withheld - licensed data. Lanes and posture are unaffected.";

/** ~6 evenly-spaced day indices for the sparse date axis (always includes the last).
 *  The end-of-range tick EVICTS the last regular tick when they'd land within ~0.7
 *  step of each other — two date labels at near-identical x painted as one doubled,
 *  unreadable smudge (Rung B1). */
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

/** Contiguous runs of a per-day value → [{ s, e, value }] inclusive. `valueFn`
 *  returns null for a day that breaks the run (a GAP — degraded days, or a false
 *  boolean lane). A new run starts whenever the non-null value changes. */
function runs(points, valueFn) {
  const out = [];
  let s = -1;
  let v = null;
  for (let i = 0; i < points.length; i++) {
    const cur = valueFn(points[i]);
    if (cur == null) {
      if (s >= 0) {
        out.push({ s, e: i - 1, value: v });
        s = -1;
      }
      continue;
    }
    if (s < 0) {
      s = i;
      v = cur;
    } else if (cur !== v) {
      out.push({ s, e: i - 1, value: v });
      s = i;
      v = cur;
    }
  }
  if (s >= 0) out.push({ s, e: points.length - 1, value: v });
  return out;
}

/** The honest empty card — no episode / no points in range (the replay-chart.js
 *  emptyCard idiom; title + one honest line, no SVG). */
function emptyCard(episode) {
  const label = episode && episode.label ? ` - ${esc(episode.label)}` : "";
  return (
    `<div class="erp-head"><h3 class="erp-title">Episode replay${label}</h3></div>` +
    `<p class="erp-empty">no replay data for this episode. ` +
    `The window may hold no trading days, or the feed is warming up.</p>`
  );
}

/** Defensive (IEF) faint line on its OWN right-hand scale, plus right-side y-ticks + axis
 *  label so the second scale is legible. Aligned to trading days. */
function defensiveOverlay(points, defensive) {
  const n = points.length;
  const withheld = defensive.length > 0 && !defensive.some((d) => Number.isFinite(d.price));
  const none = { line: "", axis: "", withheld };
  if (!defensive.length || withheld) return none;
  const defPrices = defensive.map((d) => d.price).filter((v) => Number.isFinite(v));
  let dLo = Math.min(...defPrices);
  let dHi = Math.max(...defPrices);
  if (!(dHi > dLo)) {
    dHi = dLo + 1;
    dLo -= 1;
  } // flat-series guard
  const defY = (v) => PRICE_TOP + PRICE_H - ((v - dLo) / (dHi - dLo)) * PRICE_H;
  const idxByDate = new Map(points.map((p, i) => [p.date, i]));
  const pts = [];
  for (const d of defensive) {
    const i = idxByDate.get(d.date);
    if (i != null && Number.isFinite(d.price)) pts.push(`${bandC(i, n).toFixed(1)},${defY(d.price).toFixed(1)}`);
  }
  if (pts.length <= 1) return none;
  const tickX = (F.ml + PW + 4).toFixed(1);
  const axis =
    [dLo, (dLo + dHi) / 2, dHi]
      .map(
        (v) =>
          `<text class="erp-ylabel-r" x="${tickX}" y="${(defY(v) + 3).toFixed(1)}" text-anchor="start">${v.toFixed(1)}</text>`,
      )
      .join("") +
    `<text class="erp-ylabel-r" x="${tickX}" y="${(PRICE_TOP - 4).toFixed(1)}" text-anchor="start">IEF</text>`;
  return { line: `<polyline class="erp-defensive-line" points="${pts.join(" ")}" fill="none" />`, axis, withheld };
}

/** Companion overlay (Rung E1): the picked indicator's line ON the price panel, own y-scale
 *  with left-hand native-unit ticks; the crosshair already spans it, so no extra geometry. */
function companionOverlay(episode, points, companion) {
  const n = points.length;
  const id = (companion && companion.indicatorId) || "";
  const unit = (companion && companion.unit) || "";
  const compPts = ((companion && companion.points) || []).filter((p) => Number.isFinite(p.value));
  const byDate = new Map(compPts.map((p) => [p.date, p.value]));
  const withheld = Boolean(companion && companion.redacted);
  const out = { line: "", axis: "", note: "", id, unit, byDate, withheld };
  if (withheld) {
    out.note = `<p class="erp-note">${esc(companion.label || id)}: licensed data, values withheld.</p>`;
    return out;
  }
  if (!companion) return out;
  const compLabel = companion.label || id;
  // Values drawn = the date-intersection with the episode's trading days.
  const drawn = [];
  points.forEach((p, i) => {
    const v = byDate.get(p.date);
    if (v != null) drawn.push([i, v]);
  });
  if (compPts.length === 0) {
    out.note = `<p class="erp-empty">no ${esc(compLabel)} history inside this episode window - the feed's history does not reach it.</p>`;
    return out;
  }
  if (drawn.length < 2) {
    out.note = `<p class="erp-empty">${esc(compLabel)} has under two observations on this episode's trading days - no overlay to draw.</p>`;
    return out;
  }
  const vals = drawn.map(([, v]) => v);
  let cLo = Math.min(...vals);
  let cHi = Math.max(...vals);
  if (!(cHi > cLo)) {
    cHi = cLo + 1;
    cLo -= 1;
  } // flat-series guard
  const compY = (v) => PRICE_TOP + PRICE_H - ((v - cLo) / (cHi - cLo)) * PRICE_H;
  const pts = drawn.map(([i, v]) => `${bandC(i, n).toFixed(1)},${compY(v).toFixed(1)}`);
  out.line = `<polyline class="erc-value-line" points="${pts.join(" ")}" fill="none" />`;
  const axisX = (F.ml - 6).toFixed(1);
  out.axis =
    [cLo, (cLo + cHi) / 2, cHi]
      .map(
        (v) =>
          `<text class="erp-ylabel-l" x="${axisX}" y="${(compY(v) + 3).toFixed(1)}" text-anchor="end">${esc(formatValue(v, unit))}</text>`,
      )
      .join("") +
    `<text class="erp-ylabel-l" x="${axisX}" y="${(PRICE_TOP - 4).toFixed(1)}" text-anchor="end">${esc(id)}</text>`;
  // Honest degrade: history starting AFTER the episode start is said out loud.
  const firstDate = compPts[0].date;
  if (episode.start && firstDate > episode.start) {
    out.note = `<p class="erp-note">${esc(id)} history starts ${esc(firstDate)} - earlier days in this window have no data.</p>`;
  }
  return out;
}

/**
 * One episode's replay card inner HTML. Empty/absent episode or points → the honest
 * placeholder. Everything is precomputed server-side — this seam only positions marks.
 *
 * `companion` (Rung E1, optional) is the picked companion indicator's series payload
 * (`{ indicatorId, label, unit, points }` — /api/series or /api/replay?companion=, both
 * window-sliced server-side). Its line renders ON the price panel with its OWN y-scale
 * (left-hand native-unit ticks — the IEF right-axis idiom mirrored); values match by
 * DATE onto the trading-day bands, so uncovered days are readout gaps, never a shifted
 * line. Honest degrades (empty window / partial history) render as footer notes.
 */
export function exposureReplayChartHtml(episode, companion) {
  const points = (episode && episode.points) || [];
  if (points.length === 0) return emptyCard(episode);

  const n = points.length;
  const defensive = (episode && episode.defensive) || [];

  // --- price scale over the EQUITY line only. The defensive (IEF) line gets its OWN
  //     right-hand scale below (E3 Decision 4): sharing one scale rendered IEF flat
  //     whenever its range ≪ the equity range, hiding the bond-rung move. ---
  const prices = points.map((p) => p.price).filter((v) => Number.isFinite(v));
  // No finite close at all = withheld (redacted body): no price line, no equity axis.
  const priceWithheld = prices.length === 0;
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (!(hi > lo)) {
    hi = lo + 1;
    lo -= 1;
  } // flat-series guard
  const priceY = (v) => PRICE_TOP + PRICE_H - ((v - lo) / (hi - lo)) * PRICE_H;

  // --- price line: one polyline across band centres (fire-segment closes). ---
  const priceLine = priceWithheld
    ? ""
    : points.map((p, i) => `${bandC(i, n).toFixed(1)},${priceY(p.price).toFixed(1)}`).join(" ");

  const { line: defLine, axis: defAxis, withheld: defWithheld } = defensiveOverlay(points, defensive);
  const {
    line: compLine,
    axis: compAxis,
    note: compNote,
    id: compId,
    unit: compUnit,
    byDate: compByDate,
    withheld: compWithheld,
  } = companionOverlay(episode, points, companion);

  // --- equity left axis (D3): native-unit ticks + label so the price scale is legible
  //     like the IEF right axis. A picked companion OWNS the left tick column (its axis
  //     renders in the same slot/class), so this one yields when compAxis is present. ---
  let eqAxis = "";
  if (!compAxis && !priceWithheld) {
    const axisX = (F.ml - 6).toFixed(1);
    const fmtPrice = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    eqAxis =
      [lo, (lo + hi) / 2, hi]
        .map(
          (v) =>
            `<text class="erp-ylabel-l" x="${axisX}" y="${(priceY(v) + 3).toFixed(1)}" text-anchor="end">${fmtPrice(v)}</text>`,
        )
        .join("") +
      `<text class="erp-ylabel-l" x="${axisX}" y="${(PRICE_TOP - 4).toFixed(1)}" text-anchor="end">Price</text>`;
  }

  // --- lane backing tracks + labels (r: 0 ARM, 1 FIRE, 2 Posture). ---
  let laneFrame = "";
  for (let r = 0; r < LANE_LABELS.length; r++) {
    const y = laneY(r);
    laneFrame +=
      `<rect class="erp-lane-track" x="${F.ml}" y="${y.toFixed(1)}" width="${PW.toFixed(1)}" height="${LANE_H}" />` +
      `<text class="erp-lane-label" x="${(F.ml - 6).toFixed(1)}" y="${(y + LANE_H / 2 + 3).toFixed(1)}" text-anchor="end">${LANE_LABELS[r]}</text>`;
  }

  // --- ARM lane (r0): shaded run where armed & not degraded. ---
  const armBands = runs(points, (p) => (!p.degraded && p.armed ? "on" : null))
    .map(({ s, e }) => {
      const x = bandL(s, n);
      const w = bandR(e, n) - x;
      return `<rect class="erp-arm-on" x="${x.toFixed(1)}" y="${laneY(0).toFixed(1)}" width="${w.toFixed(1)}" height="${LANE_H}" />`;
    })
    .join("");

  // --- FIRE lane (r1): shaded run where fired & not degraded. ---
  const fireBands = runs(points, (p) => (!p.degraded && p.fired ? "on" : null))
    .map(({ s, e }) => {
      const x = bandL(s, n);
      const w = bandR(e, n) - x;
      return `<rect class="erp-fire-on" x="${x.toFixed(1)}" y="${laneY(1).toFixed(1)}" width="${w.toFixed(1)}" height="${LANE_H}" />`;
    })
    .join("");

  // --- Posture lane (r2): one colour band per contiguous posture run. Degraded days
  //     are skipped (valueFn → null) so they render as GAPS, never as Core. ---
  const postureBands = runs(points, (p) => (!p.degraded && p.posture ? p.posture : null))
    .map(({ s, e, value }) => {
      const x = bandL(s, n);
      const w = bandR(e, n) - x;
      const slug = POSTURE_SLUG[value] || "core";
      return `<rect class="erp-band erp-${slug}" x="${x.toFixed(1)}" y="${laneY(2).toFixed(1)}" width="${w.toFixed(1)}" height="${LANE_H}"><title>${esc(value)}</title></rect>`;
    })
    .join("");

  // --- x-axis: ~6 sparse date ticks at band centres (trading-day axis). ---
  const ticks = tickIndices(n)
    .map((i) => {
      const cx = bandC(i, n).toFixed(1);
      return `<text class="erp-xlabel" x="${cx}" y="${(F.h - 10).toFixed(1)}" text-anchor="middle">${esc(points[i].date)}</text>`;
    })
    .join("");

  // --- per-day crosshair payload (data-hover): readout precomputed HERE so lab.js stays
  //     pure DOM wiring (no chart math client-side). x/y in SVG user units; the frame
  //     fields let the wiring letterbox-correct pointer x without importing F. ---
  const iefByDate = new Map(
    defensive.filter((d) => Number.isFinite(d.price)).map((d) => [d.date, d.price]),
  );
  const hoverDays = points.map((p, i) => {
    const ief = iefByDate.get(p.date);
    const cv = compLine ? compByDate.get(p.date) : undefined;
    const parts = [
      p.date,
      Number.isFinite(p.price) ? p.price.toFixed(2) : "-",
      ...(ief != null ? [`IEF ${ief.toFixed(2)}`] : []),
      ...(cv != null ? [`${compId} ${formatValue(cv, compUnit)}`] : []),
      p.posture || (p.degraded ? "degraded" : "-"),
    ];
    return {
      d: p.date,
      x: Number(bandC(i, n).toFixed(1)),
      y: Number.isFinite(p.price) ? Number(priceY(p.price).toFixed(1)) : null,
      r: parts.join(" · "),
    };
  });
  const hoverData = { w: F.w, h: F.h, ml: F.ml, pw: PW, days: hoverDays };

  const svg =
    `<svg class="erp-chart" viewBox="0 0 ${F.w} ${F.h}" width="100%" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" ` +
    `data-hover="${esc(JSON.stringify(hoverData))}" ` +
    `aria-label="Exposure replay for ${esc((episode && episode.label) || "")}: price, ARM key, FIRE key and posture per trading day">` +
    defLine +
    defAxis +
    compLine +
    compAxis +
    eqAxis +
    (priceLine ? `<polyline class="erp-price-line" points="${priceLine}" fill="none" />` : "") +
    laneFrame +
    armBands +
    fireBands +
    postureBands +
    ticks +
    // Crosshair spans price panel AND the three state lanes (Rung B3): the exact date
    // of a posture-colour change is read against the price line, so the vertical line
    // must cut THROUGH the bars, not stop above them. Dot/readout stay in the price panel.
    hoverLayer({ top: PRICE_TOP, height: laneY(LANE_LABELS.length - 1) + LANE_H - PRICE_TOP }) +
    `</svg>`;

  const cand = episode && episode.candidate ? `<span class="erp-cand-badge">candidate</span>` : "";
  const win = episode && episode.start && episode.end ? `<span class="erp-sub">${esc(episode.start)} → ${esc(episode.end)}</span>` : "";
  const head =
    `<div class="erp-head"><h3 class="erp-title">${esc((episode && episode.label) || "Episode replay")}</h3>${cand}${win}</div>` +
    (episode && episode.rationale ? `<p class="erp-rationale">${esc(episode.rationale)}</p>` : "");

  const legend =
    `<div class="erp-legend">` +
    `<span class="erp-key"><span class="erp-swatch erp-full"></span>Full</span>` +
    `<span class="erp-key"><span class="erp-swatch erp-core"></span>Core</span>` +
    `<span class="erp-key"><span class="erp-swatch erp-reduced"></span>Reduced</span>` +
    `<span class="erp-key"><span class="erp-swatch erp-defensive"></span>Defensive</span>` +
    `<span class="erp-key erp-key-line"><span class="erp-swatch erp-swatch-price"></span>Price (equity)${withheld(priceWithheld)}</span>` +
    (defLine || defWithheld
      ? `<span class="erp-key erp-key-line"><span class="erp-swatch erp-swatch-def"></span>IEF (bond rung)${withheld(defWithheld)}</span>`
      : "") +
    (compLine || compWithheld
      ? `<span class="erp-key erp-key-line"><span class="erp-swatch erp-swatch-comp"></span>${esc(compId)} (companion)${withheld(compWithheld)}</span>`
      : "") +
    `</div>`;

  const notes =
    ((episode && episode.notes) || []).map((t) => `<p class="erp-note">${esc(t)}</p>`).join("") +
    (priceWithheld || defWithheld ? `<p class="erp-note">${WITHHELD_NOTE}</p>` : "");
  const footer = notes || compNote ? `<div class="erp-notes">${notes}${compNote}</div>` : "";

  return head + svg + legend + footer;
}

// ── Companion picker + data routing. The four EXTERNAL companions are keyless feeds with full
//    2002-episode coverage, served by /api/replay?companion= (no stored history); every other
//    picker option is a stored dashboard indicator served by /api/series. lab.js limits the stored
//    options to ids whose history reaches 2015 (probed via /api/series at load time). ──
// Labels MUST match api/replay.ts's COMPANIONS labels verbatim: this list feeds the picker
// dropdown, while the chart legend uses the label off the /api/replay response — so any drift
// shows the user one name in the picker and another in the legend. Pinned by exposure-replay-chart.test.js.
export const EXTERNAL_COMPANIONS = [
  { id: "VIXCLS", label: "VIX" },
  { id: "T10Y2Y", label: "10Y−2Y" },
  { id: "DCOILWTICO", label: "WTI" },
  { id: "^IXIC", label: "Nasdaq" },
];
const EXTERNAL_IDS = new Set(EXTERNAL_COMPANIONS.map((c) => c.id));

/** The stored dashboard indicators eligible for the companion picker (P4): those whose /indicators
 *  meta carries a `companionAnchorDate` (history reaches the ≥2015 horizon) AND that the reader
 *  describes (`INDICATOR_DESC` keys). `{ id, label }` per eligible id, label off the served meta.
 *  Replaces the 62 per-id /series eligibility probes with one already-fetched payload. */
export function eligibleStoredCompanions(metas, descKeys) {
  const keys = descKeys instanceof Set ? descKeys : new Set(descKeys);
  return (metas || [])
    .filter((m) => m && m.companionAnchorDate != null && keys.has(m.id))
    .map((m) => ({ id: m.id, label: m.label || m.id }));
}

/** Window-sliced series URL for a companion pick — external ids route to the
 *  /api/replay companion branch, stored indicator ids to /api/series. */
export function companionSeriesUrl(id, from, to) {
  // Episode bounds are hand-set, off the month grid (EPISODES, src/exposure-replay.ts) — snap
  // to the /series grid so the P5 400 can never break a live companion chart. Floor `from`,
  // ceil the inclusive `to`: the requested window is a SUPERSET of [start, end], and the chart
  // intersects it with the episode's own trading days, so the extra margin never draws.
  const range = `&from=${encodeURIComponent(floorMonthStart(from))}&to=${encodeURIComponent(ceilMonthStart(to))}`;
  return EXTERNAL_IDS.has(id)
    ? `/api/replay?companion=${encodeURIComponent(id)}${range}`
    : `/api/series?id=${encodeURIComponent(id)}${range}`;
}

/**
 * The companion indicator picker: one `<select>` (the app.js `.ind-picker` idiom —
 * too many indicators for a chip strip) with a leading "none" option. lab.js wires the
 * change event and fetches `/api/series`.
 *
 * `options` is EITHER a flat `[{ id, label }]` list or a grouped
 * `[{ label, items: [{ id, label }] }]` list rendered as `<optgroup>`s. Both shapes are accepted
 * because the flat one is still the honest render before the family panel has loaded:
 * a group heading over an ungrouped list would be a lie, an ungrouped list is not.
 *
 * Option TEXT is passed through untouched in both shapes. It must stay verbatim-equal to
 * `api/replay.ts`'s COMPANIONS labels (`prose-names.test.ts` pins it) — grouping changes
 * the wrapping and the sequence, never a name.
 */
export function companionPickerHtml(options, selectedId) {
  const opts = options || [];
  if (opts.length === 0) return "";
  const optionHtml = (o) =>
    `<option value="${esc(o.id)}"${o.id === selectedId ? " selected" : ""}>${esc(o.label || o.id)}</option>`;
  const grouped = opts.some((o) => Array.isArray(o.items));
  const items = grouped
    ? opts
        .filter((g) => Array.isArray(g.items) && g.items.length)
        .map((g) => `<optgroup label="${esc(g.label)}">${g.items.map(optionHtml).join("")}</optgroup>`)
        .join("")
    : opts.map(optionHtml).join("");
  if (items === "") return "";
  return (
    `<div class="erc-picker"><label class="erc-picker-l">compare indicator ` +
    `<select class="erp-ind-picker" aria-label="companion indicator">` +
    `<option value=""${selectedId ? "" : " selected"}>- none -</option>${items}` +
    `</select></label></div>`
  );
}

/**
 * The episode picker: one small chip per episode. `candidate: true` episodes are
 * visibly marked (dimmed/dashed via .erp-candidate — the Concept-shelf chip idiom) so
 * the user can rule on drops. The selected chip carries aria-current. Pure projection;
 * lab.js wires the clicks (data-episode) and re-renders the chart client-side.
 */
export function episodeChipsHtml(episodes, selectedId) {
  const eps = episodes || [];
  if (eps.length === 0) return "";
  const chips = eps
    .map((ep) => {
      const on = ep.id === selectedId;
      const cand = ep.candidate ? " erp-candidate" : "";
      return (
        `<button type="button" class="chip-m erp-chip${cand}" data-episode="${esc(ep.id)}"` +
        `${on ? ' aria-current="true"' : ""}${ep.candidate ? ' title="candidate — decide keep/drop"' : ""}>` +
        `<span class="cm-t">${esc(ep.label || ep.id)}</span>` +
        (ep.candidate ? `<span class="erp-chip-cand">candidate</span>` : "") +
        `</button>`
      );
    })
    .join("");
  return `<div class="picker erp-picker"><div class="grp"><span class="grp-lbl">Episode</span>${chips}</div></div>`;
}
