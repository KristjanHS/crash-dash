/**
 * The `/lab` FEED-LAG PANEL — a pure, DOM-free seam beside `feed-lag-foot.js`.
 *
 * §4.3 makes the panel a LAZY disclosure: a header toggle renders up front (no data), and
 * `/api/status.feedLag` is fetched only on the FIRST expand — a normal `/lab` visit costs zero extra
 * requests. This seam stays pure: the fetch/lifecycle lives in `lab.js`/`lab-board.js`. Three pieces:
 *   • `feedLagReduce(state, event, payload)` — the pure state machine. The `fetch` flag it returns is
 *     the ONE signal `lab.js` fetches on; it is true ONLY on the expand that leaves `phase: "idle"`,
 *     so no request fires before the first expand and none on any later expand/collapse.
 *   • `feedLagPanelShellHtml(state, labels)` — the disclosure markup (toggle + phased body).
 *   • `feedLagPanelHtml(rows, labels)` — the roster BODY: the WHOLE served roster (§7.2), one row per
 *     feed in the order served (lagging first — never re-sorted here), no inner collapse/filter.
 *
 * Nothing is recomputed: every number is read off the row. `age`/`ageUnit` are NULL wherever the
 * server had no measurement — a zero-row feed, or one whose publication calendar could not be built
 * — and such a row renders `—` for age, NEVER a fabricated `0`. `lagCut`/`deepLagBar` are always
 * numbers; their unit follows `ageUnit`, falling back to the cadence's own unit (daily/weekly ⇒
 * slots, else days — the `ageUnit` contract in `src/api/types.ts`) only where `ageUnit` is null.
 *
 * Covered by `feed-lag-panel.test.js`; never imported from `lab.js` in a test
 * (`.claude/rules/frontend.md`).
 */
import { esc } from "./chart-primitives.js";
import { posAttrs } from "./inline-pos.js";
import { idIfDistinct } from "./leading-name.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
// The `ageUnit` contract: slot-calendared feeds vs calendar-day ones. Used ONLY to unit-label the
// always-present cut/bar of a feed served without an age, where `ageUnit` is null.
const unitForCadence = (cadence) => (cadence === "daily" || cadence === "weekly" ? "slots" : "days");

/** The panel's initial disclosure state: collapsed, nothing fetched yet. */
export const FEED_LAG_INIT = { open: false, phase: "idle", rows: null };

/**
 * Pure disclosure state machine. `event` is `"toggle"` (header click), `"loaded"` (fetch resolved —
 * `payload` = the roster), or `"failed"` (fetch failed). Returns `{ state, fetch }`, where `fetch`
 * is true iff `lab.js` should now issue the ONE `/api/status` request — only on the expand out of
 * `idle`, never before the first expand and never again (loaded or failed both leave `idle`).
 */
export function feedLagReduce(state, event, payload) {
  const s = state || FEED_LAG_INIT;
  switch (event) {
    case "toggle": {
      const open = !s.open;
      if (open && s.phase === "idle") return { state: { ...s, open, phase: "loading" }, fetch: true };
      return { state: { ...s, open }, fetch: false };
    }
    case "loaded":
      return { state: { ...s, phase: "ready", rows: payload }, fetch: false };
    case "failed":
      return { state: { ...s, phase: "error", rows: null }, fetch: false };
    default:
      return { state: s, fetch: false };
  }
}

/**
 * @param {{open: boolean, phase: "idle"|"loading"|"ready"|"error", rows: object[]|null}} state
 * @param {Record<string, string>} labels feed-id → served label (injected at the `lab.js` call site)
 * @returns {string} the disclosure markup — toggle always, body only while open
 */
export function feedLagPanelShellHtml(state, labels) {
  const s = state || FEED_LAG_INIT;
  const glyph = s.open ? "▾" : "▸";
  const head =
    `<button class="fl-toggle" type="button" aria-expanded="${s.open ? "true" : "false"}" aria-controls="flBody">` +
    `feed lag ${glyph}</button>`;
  let body = "";
  if (s.open) {
    if (s.phase === "loading") body = `<p class="fl-note">Loading feed lag…</p>`;
    else if (s.phase === "error") body = `<p class="fl-note fl-err">Couldn't load feed lag.</p>`;
    else if (s.phase === "ready") body = feedLagPanelHtml(s.rows, labels);
    body = `<div class="fl-body" id="flBody">${body}</div>`;
  }
  return `<div class="fl-panel-inner">${head}${body}</div>`;
}

/** Status key → its on-screen word. Every key is a `fl-st-<key>` class styled in `lab.css` — the
 *  diagnostic hue ramp (`--fl-*`), deliberately off the red/amber/green danger palette. */
export const FEED_LAG_STATUS_LABEL = {
  fresh: "fresh",
  lag: "LAG",
  deep: "DEEP LAG",
  nodata: "NO DATA",
  unmeasured: "UNMEASURED",
};

/**
 * One row's status. The LAG verdict is the served `lag` flag (the pill's own verdict — it nets each
 * feed's measured release delay, so it is NOT re-derived as `age > lagCut` here); the deep split is the
 * served `deep` verdict, falling back to `age > deepLagBar` only on a row the server sent none for. A
 * lagging row with no age is a zero-row feed (NO-DATA, the heavier tier in `lagTier`, src/feed-lag.ts).
 * @returns {keyof typeof FEED_LAG_STATUS_LABEL}
 */
export function feedLagStatus(r) {
  if (r.unmeasured) return "unmeasured";
  if (!r.lag) return "fresh";
  if (!finite(r.age)) return "nodata";
  const deep = typeof r.deep === "boolean" ? r.deep : r.age > r.deepLagBar;
  return deep ? "deep" : "lag";
}

const num = (n, unit) => `${n} <span class="fl-u">${n === 1 ? unit.replace(/s$/, "") : unit}</span>`;

/** The age-position gauge: a 0 → deep-lag-bar track, a tick at the healthy cut, the age as the fill
 *  (clamped at the bar — a DEEP LAG row reads full). A null age emits no fill width, so it stays empty. */
function gaugeHtml(r, status) {
  const bar = r.deepLagBar > 0 ? r.deepLagBar : null;
  const pct = (v) => (bar && finite(v) ? Math.min(100, Math.max(0, (v / bar) * 100)) : null);
  return (
    `<span class="fl-gauge">` +
    `<span class="fl-gauge-fill fl-st-${status}"${posAttrs({ width: pct(r.age) })}></span>` +
    `<span class="fl-gauge-tick"${posAttrs({ left: pct(r.lagCut) })}></span>` +
    `</span>`
  );
}

/**
 * The roster BODY (no disclosure chrome): a column table — Feed · Status · Age (+ gauge) · Healthy ≤ ·
 * Deep-lag > · Bar — plus the status/gauge/provenance legend.
 * @param {Array<{id: string, cadence: string, age: number|null, ageUnit: "slots"|"days"|null,
 *   lagCut: number, deepLagBar: number, source: "p90"|"tier"|"run-row", deep?: boolean, lag?: boolean, unmeasured?: boolean, provisional?: true}>} rows
 *   the served `/api/status.feedLag` roster
 * @param {Record<string, string>} labels feed-id → served label
 * @returns {string} the roster markup, or `""` when the roster is absent/empty
 */
export function feedLagPanelHtml(rows, labels) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return "";
  const lbls = labels || {};
  const items = list
    .map((r) => {
      const unit = r.ageUnit || unitForCadence(r.cadence);
      const status = feedLagStatus(r);
      const lab = lbls[r.id];
      const name = [idIfDistinct(lab, r.id), lab].filter(Boolean).join(" ");
      // `run-row` age is the last-fetch date (an unmeasured feed's calendar was uncomputable), so it
      // reads "last fetched", never "now"/"published" — the SHAPE-NOT-SEMANTICS closure (src/feed-lag.ts).
      const mark = r.source === "p90" ? "meas" : r.source === "run-row" ? "fetched" : "tier";
      const markCls = r.source === "p90" ? "fl-src-meas" : r.source === "run-row" ? "fl-src-fetched" : "fl-src-tier";
      const ageTxt = finite(r.age) ? num(r.age, unit) : "-";
      const ageWhen =
        (r.source === "run-row" ? ` <span class="fl-when">last fetched</span>` : "") +
        (r.provisional === true ? ` <span class="fl-when">INTRADAY</span>` : "");
      return (
        `<tr class="fl-row fl-st-${status}${r.lag ? " is-lag" : ""}${r.unmeasured ? " is-unmeasured" : ""}">` +
        `<td class="fl-name">${esc(name)}</td>` +
        `<td><span class="fl-pill fl-st-${status}">${FEED_LAG_STATUS_LABEL[status]}</span></td>` +
        `<td class="fl-num fl-age">${ageTxt}${ageWhen}</td>` +
        `<td class="fl-gauge-cell">${gaugeHtml(r, status)}</td>` +
        `<td class="fl-num fl-cut">${num(r.lagCut, unit)}</td>` +
        `<td class="fl-num fl-bar">${num(r.deepLagBar, unit)}</td>` +
        `<td class="fl-src ${markCls}">${mark}</td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<div class="fl-table-wrap"><table class="fl-table">` +
    `<thead><tr><th>Feed</th><th>Status</th><th class="fl-num">Age</th><th></th>` +
    `<th class="fl-num">Healthy ≤</th><th class="fl-num">Deep-lag &gt;</th><th>Bar</th></tr></thead>` +
    `<tbody>${items}</tbody></table></div>` +
    `<p class="fl-legend"><span class="fl-pill fl-st-lag">LAG</span> past its healthy cut · ` +
    `<span class="fl-pill fl-st-deep">DEEP LAG</span> past the deep-lag bar · ` +
    `<span class="fl-pill fl-st-nodata">NO DATA</span> nothing stored · ` +
    `<span class="fl-pill fl-st-unmeasured">UNMEASURED</span> publication calendar uncomputable. ` +
    `Gauge: age on a 0 → deep-lag scale, tick = healthy cut.</p>` +
    `<p class="fl-legend">Bar: <span class="fl-src-meas">meas</span> measured lag gap — 2× the larger of this feed’s p90 and its tier · ` +
    `<span class="fl-src-tier">tier</span> derived from the cadence tier · ` +
    `<span class="fl-src-fetched">fetched</span> calendar uncomputable — age is when it was last fetched, not published</p>`
  );
}
