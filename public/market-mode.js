/**
 * Market-mode display seam (pure, no DOM) so vitest collects the logic while `tsc`
 * (no allowJs) ignores it — same seam idiom as sub-dangers.js / tile-members.js.
 *
 * A per-leg danger×growth QUADRANT label, DISPLAY-ONLY. The mode never touches selection or danger
 * math — it is a read-time re-expression of the two SERVED scalars `LegRowDTO.danger` +
 * `LegRowDTO.growth`. The display-only invariant (no mode string reaches `computeField`) holds BY
 * CONSTRUCTION: the mode exists only here, in a FE-only `public/*.js` seam that `src/*.ts` cannot
 * import at runtime.
 *
 * Labels use the textbook Wyckoff market-cycle vocabulary (Accumulation → Markup →
 * Distribution → Markdown), two-word descriptive form.
 */

/** The four labels keyed by danger×growth cell — single source for the label strings.
 *  hiDan = danger ≥ the served amber cut; hiGro = growth ≥ 0.5 (the [0,1] neutral midpoint). */
export const MARKET_MODES = Object.freeze({
  hiDanHiGro: "euphoric distribution",
  loDanLoGro: "calm accumulation",
  loDanHiGro: "healthy markup",
  hiDanLoGro: "risk-off markdown",
});

/** Per-label Wyckoff phase tooltip — single source for the `title` copy, keyed by the label
 *  string so `marketModeCellHtml` looks it up from a mode alone. Keys MUST cover every
 *  `MARKET_MODES` value (pinned in the test). */
export const MARKET_MODE_TIPS = Object.freeze({
  "calm accumulation": "Accumulation - calm bottom, smart money buying",
  "healthy markup": "Markup - healthy uptrend, low stress",
  "euphoric distribution": "Distribution - euphoric top, rising but elevated",
  "risk-off markdown": "Markdown - risk-off decline, high stress",
});

/** The ledger's Mode cell paints an ARROW, not the label text. What separates the shapes is the
 *  IMPLIES clause, so the full key (glyph · name · means · implies) is mandatory wherever the column
 *  paints — a bare glyph→name legend does NOT satisfy the rung, and is nowhere in the code. All four
 *  parts are painted in full by `marketModeQuadrantHtml`, and the per-cell `title=` on
 *  `marketModeCellHtml` carries the whole contract at the glyph itself. */
export const MARKET_MODE_GLYPHS = Object.freeze({
  "calm accumulation": "↗",
  "healthy markup": "↑",
  "euphoric distribution": "↘",
  "risk-off markdown": "↓",
});

/** The na glyph — kept here beside the four so the footnote's 5th row and the cell agree. */
export const MODE_NA_GLYPH = "-";

/** Per-mode IMPLICATION — what the quadrant means for the HOLD, the clause that separates the two
 *  up-arrows (and the two down-arrows) from each other. Keys MUST cover every `MARKET_MODES` value
 *  (pinned in the test). Still DISPLAY-ONLY prose: nothing here is read by any decision path. */
export const MARKET_MODE_IMPLIES = Object.freeze({
  "calm accumulation": "a base, not a trend - cheap to hold, but nothing is paying you for it yet",
  "healthy markup": "the regime the ladder is built to hold - an aggressive rung is earning its risk",
  "euphoric distribution": "still rising, on borrowed calm - treat the upside as rented, not owned",
  "risk-off markdown": "the danger is already being paid in price - suggests rotating down from",
});

/** Stable css class token per mode label (used by the RRG box tint + the column cell).
 *  NOTE: the /lab column cell (`marketModeCellHtml`) and the footnote colour these glyphs, but ONLY
 *  under selectors scoped to their host — `.df-grid .col-mode .<mode>` / `.df-foot-modes .<mode>`
 *  (lab.html) — alongside the RRG's own `.rrg-leg.<mode>::before` / `.rrg-swatch.<mode>` (lab.js).
 *  Do NOT add an UNSCOPED `.mode-*` rule — it would bleed into the RRG stripe/swatch. Pinned:
 *  `market-mode.test.js` §"colour selectors are SCOPED". */
const MODE_CLASS = Object.freeze({
  "calm accumulation": "mode-accum",
  "healthy markup": "mode-markup",
  "euphoric distribution": "mode-distrib",
  "risk-off markdown": "mode-markdown",
});

/**
 * Pure danger×growth quadrant label, or `null` when growth is absent / non-finite.
 *
 * @param {number} danger  served `LegRowDTO.danger` (always finite).
 * @param {number|null} growth  served `LegRowDTO.growth` (null on a non-live pillar).
 * @param {number} amber  the SERVED `DANGER_CUTS.amber` (leg green→amber cut) — REQUIRED, no
 *   default literal here; the caller passes the served cut so the mode's danger boundary agrees
 *   with every other danger colouring on /lab.
 * @param {number} [mid=0.5]  the growth split — 0.5, the [0,1] growth neutral midpoint
 *  .
 *   NOT a tunable: it is the image of an all-neutral leg under `computeLegGrowth`, not re-hard-coded.
 */
export function marketMode(danger, growth, amber, mid = 0.5) {
  if (typeof growth !== "number" || !Number.isFinite(growth)) return null;
  const hiDan = danger >= amber;
  const hiGro = growth >= mid;
  if (hiDan) return hiGro ? MARKET_MODES.hiDanHiGro : MARKET_MODES.hiDanLoGro;
  return hiGro ? MARKET_MODES.loDanHiGro : MARKET_MODES.loDanLoGro;
}

/** Stable css class token for a mode label (for the RRG tint + column class), `""` when null. */
export function marketModeClass(mode) {
  return mode == null ? "" : MODE_CLASS[mode] || "";
}

/** The /lab Mode column cell markup: the mode's ARROW (IS-8(c)), or the `–` na glyph when
 *  `mode == null`. The label text left the cell with the glyph, so the hover carries the full
 *  contract the footnote paints — NAME · what it MEANS (the Wyckoff tip) · what it IMPLIES.
 *  Kept here (not lab.js) so the markup is unit-testable without jsdom. */
export function marketModeCellHtml(mode) {
  if (mode == null)
    return `<span class="mode-glyph mode-na" title="growth not live for this leg - read the mode as ABSENT, never as calm">${MODE_NA_GLYPH}</span>`;
  const tip = `${mode} · ${MARKET_MODE_TIPS[mode] || ""} · implies ${MARKET_MODE_IMPLIES[mode] || ""}`;
  return `<span class="mode-glyph ${marketModeClass(mode)}" title="${tip}">${MARKET_MODE_GLYPHS[mode]}</span>`;
}

/** The mandatory contract in its flat-footnote form. Per mode it carries the GLYPH, its NAME, what it
 *  MEANS (the Wyckoff tip) and what it IMPLIES, plus the na row ("no arrow" must not read as "calm").
 *  Derived from the same frozen maps the cell reads. NOT the live /lab paint — the ledger renders
 *  `marketModeQuadrantHtml()` instead; kept as the reference rendering `market-mode.test.js` pins, so
 *  the quadrant below can never quietly drop a part this form carries. */
export function marketModeFootHtml() {
  const key = (glyph, cls, name, means, implies) =>
    `<span class="mode-key"><span class="mode-glyph ${cls}">${glyph}</span>` +
    `<b>${name}</b> · ${means} · <i>implies</i> ${implies}</span>`;
  const rows = Object.values(MARKET_MODES)
    .map((m) => key(MARKET_MODE_GLYPHS[m], marketModeClass(m), m, MARKET_MODE_TIPS[m], MARKET_MODE_IMPLIES[m]))
    .join("");
  return (
    `<span class="df-foot-note df-foot-modes">Mode column (danger×growth, DISPLAY-ONLY - feeds no decision):` +
    rows +
    key(
      MODE_NA_GLYPH,
      "mode-na",
      "not live for this leg",
      "the growth pillar has no live reading here",
      "read the mode as ABSENT, never as calm - an unmeasured leg is not a quiet one",
    ) +
    `</span>`
  );
}

/**
 * The /lab paint of the mode contract: the SAME four parts (glyph · name · means · implies) plus the
 * na row, laid on the danger×growth axes they are derived from instead of a flat five-row list. Lives
 * inside the danger ledger's collapsed legend (`#dfLegend`, lab.js).
 *
 * Everything is DERIVED, nothing retyped: the labels from `MARKET_MODES`, the arrows from
 * `MARKET_MODE_GLYPHS`, the means clause from `MARKET_MODE_TIPS`, the implies clause from
 * `MARKET_MODE_IMPLIES` — and each cell's QUADRANT COORDINATES from its `MARKET_MODES` KEY
 * (`hiDanLoGro` → danger HIGH · growth LOW), so a cell can never be placed in the wrong quadrant
 * without the key itself being wrong. Grid PLACEMENT is by class (`.df-mq-<hi|lo>dan-<hi|lo>gro`,
 * lab.html), never by DOM order — the frozen map's key order is the ruled table's, not the
 * quadrant's. That holds at ≥640px only: lab.html's `@media (max-width: 640px)` resets every cell to
 * `grid-column: 1; grid-row: auto`, so below that the 2×2 collapses to one column and the cells DO
 * auto-place in `MARKET_MODES` key order — which is safe because each cell also prints its own
 * quadrant coordinates.
 *
 * ⚠ The wrapper keeps the `df-foot-modes` class: that class is the SCOPE the `.mode-*` colour rules
 * hang off (lab.html §SCOPING IS LOAD-BEARING,
 * pinned by `market-mode.test.js` §"colour selectors are SCOPED"). Dropping it would either strip
 * the tints or tempt an unscoped `.mode-accum` rule that bleeds into the View-C RRG quadrant.
 */
export function marketModeQuadrantHtml() {
  const cell = (key, mode) => {
    const hiDan = key.startsWith("hiDan");
    const hiGro = key.endsWith("HiGro");
    return (
      `<div class="df-mq-cell df-mq-${hiDan ? "hi" : "lo"}dan-${hiGro ? "hi" : "lo"}gro">` +
      `<div class="df-mq-name"><span class="mode-glyph ${marketModeClass(mode)}">${MARKET_MODE_GLYPHS[mode]}</span> ` +
      `<b>${mode}</b></div>` +
      `<div class="df-mq-coord">danger ${hiDan ? "HIGH" : "LOW"} · growth ${hiGro ? "HIGH" : "LOW"}</div>` +
      `<div>${MARKET_MODE_TIPS[mode]}</div>` +
      `<div class="df-mq-implies"><i>implies</i> ${MARKET_MODE_IMPLIES[mode]}</div>` +
      `</div>`
    );
  };
  return (
    `<div class="df-foot-modes">` +
    `<div class="df-mq">` +
    `<div class="df-mq-x">◀ growth LOW · growth HIGH ▶</div>` +
    `<div class="df-mq-y"><span>danger HIGH ▲</span><span>danger LOW ▼</span></div>` +
    Object.entries(MARKET_MODES)
      .map(([k, m]) => cell(k, m))
      .join("") +
    `</div>` +
    `<div class="df-mq-na"><span class="mode-glyph mode-na">${MODE_NA_GLYPH}</span> ` +
    `<b>not live for this leg</b> - the growth pillar has no reading here. Read as ABSENT, never ` +
    `as calm: an unmeasured leg is not a quiet one.</div>` +
    `</div>`
  );
}
