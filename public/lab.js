/**
 * Market-Methods Learning Lab — /lab front-end (the "instrument bench").
 *
 * Two regions over the SAME server engine (no client-side veto/score math, no LLM):
 *  - Board (left, sticky): family tiles + a board-head danger read (regime/score/firing).
 *    The per-leg Danger ledger renders below the bench.
 *  - Reader (right, independent scroll): a sticky chip strip of the 11 methods (the
 *    "picker") atop the selected method's full text + the "Firing now on the board ↑"
 *    callout tying the text to what the board shows. Picking a chip drives the board.
 *
 * Data is server-sourced: GET /api/lab for the latest cron snapshot (Live), or
 * '/api/lab?s=key:STATE,…' for a hand-set / method-preset scenario. Cash (rung 10)
 * and R4's cash breaker are VIEW-ONLY overlays — the shared engine stays a 9-leg
 * equity ladder.
 */
import { esc } from "./chart-primitives.js";
import { METHOD_CARDS } from "./method-cards.js";
import { chipDetailTarget, detailJumpUrl } from "./detail-jump.js";
import { decorateHelp, setHTML, wireHelpBar } from "./help-bar.js";
import { secTip } from "./section-tips.js";
import { renderBandPanel } from "./band-panel.js";
import { cashClaimHtml } from "./cash-overlay-view.js";
import { makeEquityPctLoader } from "./exposure-equity.js";
import { paintLive } from "./lab-live-paint.js";
import { overlayStripHtml, overlayFieldValue, R4_PHASE_LABEL } from "./overlay-strip.js";
import { replayChartHtml } from "./replay-chart.js";
import { coverageLegendHtml } from "./coverage-marks.js";
import { intradayVerdictLabel } from "./feed-age-mark.js";
import {
  exposureReplayChartHtml,
  episodeChipsHtml,
  companionPickerHtml,
  companionSeriesUrl,
  eligibleStoredCompanions,
  EXTERNAL_COMPANIONS,
} from "./exposure-replay-chart.js";
import { defaultEpisodeId } from "./exposure-view.js";
import { SCENARIO_WALK_DAYS } from "./held-path.js";
import { groupMetasByFamily } from "./picker-groups.js";
import { INDICATOR_DESC } from "./indicator-desc.js";
import { buildBandPanel, buildDangerField, buildQuadrant, buildScoreboard, buildStructureMap, cacheLast, cacheLastD, dangerModel, dfFootDefault, dangerFieldSkeletonHtml, breakerFootHtml, feedLagFoot, feedLagPanel, loadDangerModel, renderDangerField, renderQuadrant, renderScoreboard, renderStructureMap, resetScnMomentum, resolveField } from "./lab-board.js";
import { LAB_LOOKBACK } from "./lab-lookback.js";
import { DEFAULT_REENTRY_LEG, REENTRY_TOGGLES, loadReentry, readOpenState, renderReentry, writeOpen } from "./lab-reentry.js";
import { feedLagReduce, FEED_LAG_INIT } from "./feed-lag-panel.js";
import { renderReader } from "./lab-reader.js";
import { buildFamiliesBoard, renderFamiliesBoard } from "./families-board.js";
import { buildPicker } from "./lab-chips.js";
import { apiFetch, canViewPage, loadSession } from "./auth-session.js";
import { fetchOnce, fetchOnceVia, prefetchThenGate } from "./gate-prefetch.js";
import { API_TIMEOUT_MS, getJson, request } from "./http.js";

// The live board read: the r4 HY OAS / fall velocity / band row come from /api/lab itself (through `apiFetch`).
const liveFetch = fetchOnceVia(apiFetch);
// The landing view's reads start before the gate (taken by `fetchOnce`/`liveFetch`), off the renewal path. The live
// /api/lab read is prefetched only on a LIVE session: an expired one renews in the gate first, so no take runs ahead of the renewal.
const BOOT_URLS = [
  ...(new URLSearchParams(location.search).get("s")
    ? []
    : [...(loadSession() ? [`/api/lab?hist=${LAB_LOOKBACK}${walkParam()}`] : []), "/api/exposure"]),
  "/api/danger-model",
];
// P11-gate — before any localStorage paint: `canViewPage` says no ⇒ /overview.
if (!(await prefetchThenGate(BOOT_URLS, canViewPage, apiFetch))) {
  location.replace("/overview");
  await new Promise(() => {}); // hold the module while the navigation lands
}


const LOOKBACK = LAB_LOOKBACK; // the shared /api/lab?hist= key (lab-lookback.js) — one constant so the edge-cache key can never split

// Client-side view state. `scenario` holds ONLY non-default overrides (a live
// family at GREEN or dispersion "off" is absent) — mirroring the ?s= encoding.
let mode = "live";
let scenario = {};
// --- Historical-replay (mode 2b) range state (module-level so setMode can fetch before the
// card renders). Default = 1y ending today. A preset click sets replayPreset + recomputes the
// edges; a date-input edit clears replayPreset (custom range). The fetch is `/api/lab?replay=
// <start>:<end>` — debounced exactly like scenario refetches (100ms). No engine math here: the
// server ships finished points; replay-chart.js only positions them. ---
const REPLAY_PRESETS = { "1y": 1, "3y": 3, "5y": 5, "10y": 10 };
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function isoYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}
let replayPreset = "1y";
let replayStart = isoYearsAgo(1);
let replayEnd = todayIso();
// Per-family {label, ids[], state} map for the replay coverage bar. ReplayResponse carries no
// family panel, so it's cached from the last live/scenario board (which DOES carry
// d.globalFamilies) — the simplest idiom given the file already renders replay only after a
// live/scenario landing built the bench. Defaults to [] (replay-chart renders no coverage bar).
let replayFamilyMembers = [];
// The picker chip / reader currently open. Default R5 = cleanest one-family cause→effect.
let selectedMethodId = "R5";
// Does the selected method drive the board? True only after a picker click; the
// hand-cycle / mode-toggle / live paths clear it, so the Cash breaker (methodDrives
// + R4.cashBreaker) never fires from those and the held marker floors at 9.
let methodDrivesBoard = false;
let debounceTimer = null;
// Monotonic fetch token: a slower earlier response can't clobber a newer render.
let fetchGen = 0;
// The board skeleton (tiles + persistent rungs/markers + picker) is built once, then
// updated in place so the markers TRAVEL via CSS transitions.
let built = false;
// Per-section visibility, persisted PER MODE (localStorage `lab.visible`). Method cards toggle the
// `.collapsed` class on #lab (reuses the full-width-board / reader-out-of-flow layout); the other 3
// sections toggle `.is-hidden` on their wrapper. Defaults, both modes ([USER] 2026-08-29): the landing
// view is the floors strip + Families board + Danger ledger ONLY — Method cards, Structure map, Rotation
// quadrant and Scoreboard are opt-in reading surfaces. Any toggle writes the CURRENT mode's map (a
// returning user's stored map wins, so this moves the NEW-user landing only). Cards hidden ⇒
// #lab.collapsed (full-width board, reader out of flow).
const VIS_KEY = "lab.visible";
const VIS_DEFAULTS = {
  live: { familiesBoard: true, cards: false, dangerField: true, structureMap: false, rrgQuadrant: false, scoreboard: false, reentry: false },
  scenario: { familiesBoard: true, cards: false, dangerField: true, structureMap: false, rrgQuadrant: false, scoreboard: false, reentry: false },
};
// The non-cards sections whose wrapper id === the map key (cards is special: #lab.collapsed;
// familiesBoard ALSO mirrors to #lab.board-hidden so the bench drops the empty board column).
// The scoreboard is ALSO data-gated: scenario responses carry no `scoreboard` field, so
// renderScoreboard sets the wrapper's `hidden` attr independently of this per-mode toggle.
// familiesBoard = the topmost regime/danger-score board; stored maps that
// predate a key inherit its default via the loadVisible spread — no migration needed.
const VIS_HIDEABLE = ["familiesBoard", "dangerField", "structureMap", "rrgQuadrant", "scoreboard", "reentry"];
function loadVisible() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(VIS_KEY) || "{}") || {};
  } catch {
    raw = {};
  }
  return {
    live: { ...VIS_DEFAULTS.live, ...(raw.live || {}) },
    scenario: { ...VIS_DEFAULTS.scenario, ...(raw.scenario || {}) },
  };
}
let visibleByMode = loadVisible();

// The CURRENT posture's equity weight (/api/exposure), used ONLY to size the footer cash chip.
// Deliberately NOT memoized like loadDangerModel: that caches a static
// constant table, while this is current state that moves when the cron flips posture — and a
// lifetime memo would also pin a transient first failure at "not yet sized" for the whole session.
// So it re-issues per fetchLive() and only dedupes an in-flight read (see makeEquityPctLoader).
// A failed read sizes nothing (null, never a fabricated weight); scenario/replay boards keep null.
const exposureEquity = makeEquityPctLoader(fetchOnce);

// §4.3 — the feed-lag panel is a LAZY disclosure: `/api/status` is fetched only on the FIRST expand,
// so a normal `/lab` visit costs zero extra requests. The pure `feedLagReduce` (feed-lag-panel.js)
// owns the state; `lab.js` fetches iff its returned `fetch` flag is true and re-paints on each change.
let feedLagState = FEED_LAG_INIT;

function renderFeedLagPanel() {
  const host = document.getElementById("feedLagPanel");
  if (host) setHTML(host, feedLagPanel(feedLagState));
}

/** Header-click handler (delegated on #feedLagPanel). The ONLY /api/status fetch on /lab, gated by
 *  the reducer's `fetch` flag so it fires exactly once, on the first expand. */
async function onFeedLagToggle(e) {
  if (!e.target.closest(".fl-toggle")) return;
  const { state, fetch: doFetch } = feedLagReduce(feedLagState, "toggle");
  feedLagState = state;
  renderFeedLagPanel(); // paint the new open/loading state before the (possible) fetch
  if (!doFetch) return;
  let rows = null;
  try {
    const res = await request("/api/status", { fetchImpl: apiFetch, timeoutMs: API_TIMEOUT_MS });
    const data = res.ok ? await res.json() : null;
    rows = data && Array.isArray(data.feedLag) ? data.feedLag : null;
  } catch {
    rows = null;
  }
  feedLagState = feedLagReduce(feedLagState, rows ? "loaded" : "failed", rows).state;
  renderFeedLagPanel();
}

const $ = (sel) => document.querySelector(sel);


/* ============================================================ SKELETON (once) */

function buildBench(d) {
  const lab = document.getElementById("lab");
  // ALLOWLISTED raw write (write-seam.test.js): the build skeleton carries no `title=` at all, and
  // the build-time `decorateHelp(lab)` below walks this very host once it is populated.
  lab.innerHTML = `
    <section class="band-panel-host" id="bandPanelHost" aria-label="Alert-band escalator floors"></section>
    <div class="bench">
      <section class="board" id="familiesBoard" aria-label="Scenario board"></section>
      <article class="reader" id="reader">
        <h2 class="rd-title sec-tip"${secTip("methodCards")}>Method cards</h2>
        <nav class="picker" id="picker" aria-label="Method catalog"></nav>
        <div class="reader-body" id="reader-body"></div>
      </article>
    </div>
    <section class="danger-field" id="dangerField" aria-label="Per-leg danger field - View A">${dangerFieldSkeletonHtml()}
    </section>
    <section class="structure-map" id="structureMap" aria-label="Structure map - View B">
      <div class="sm-head"><h2 class="sm-title sec-tip"${secTip("structureMap")}>Structure map</h2>
        <span class="sm-note">region × exposure · cell tint = own-danger · hover a cell for the sleeve</span></div>
      <div class="sm-grid-wrap" id="smGridWrap"></div>
    </section>
    <section id="rrgQuadrant" aria-label="Rotation quadrant - View C"></section>
    <section class="scoreboard" id="scoreboard" aria-label="Live scoreboard - D9 gates" hidden>
      <div id="sbBody"></div>
    </section>
    <section class="reentry" id="reentry" aria-label="Leg re-entry"></section>
    <section class="replay-card is-hidden" id="replayCard" aria-label="Historical replay"></section>`;
  // Board skeleton + tiles: the families-board.js seam (MOVE-ONLY extraction, P11) — the
  // read-only /overview page builds the SAME board from this one implementation.
  buildFamiliesBoard(document.getElementById("familiesBoard"), d);
  buildPicker(selectedMethodId, select);
  buildDangerField(d);
  buildBandPanel();
  buildStructureMap(d);
  buildQuadrant(d);
  buildScoreboard(d);
  buildReplay(d);
  // The feed-lag disclosure listener rides #feedLagPanel (persists across setHTML of its children),
  // so it survives every poll re-paint without re-binding.
  const flPanel = document.getElementById("feedLagPanel");
  if (flPanel) flPanel.addEventListener("click", onFeedLagToggle);
  // #lab is tap-first (data-help="tap-first"): decorateHelp injects NO glyphs here except the
  // irreducible HELP_GLYPH_KEEP_SELECTOR hosts — [title] hosts are tap-readable on the text.
  decorateHelp(lab);
  // Section visibility (incl. #lab.collapsed for cards) is applied at the end of applyBoard via
  // applyVisibility(d) — no landing-collapse toggle needed here.
  built = true;
}


/* ===================================================== HISTORICAL REPLAY (mode 2b)
 * A third mode alongside live/scenario: a date-range control drives `/api/lab?replay=
 * <start>:<end>`, and the server-computed ReplayResponse is drawn by the pure
 * replay-chart.js seam (leg-path per trading day + R4 cash overlay). Learning view only —
 * no verdict, no return math. The card owns #lab entirely in replay mode (every
 * live/scenario section is hidden via applyVisibility); switching back restores the prior
 * mode's persisted visibility map. */

/** Once, in buildBench: the #replayCard wrapper already exists in the buildBench innerHTML.
 *  renderReplay repaints its whole body each fetch, so the range-control listeners are
 *  delegated ONCE on the stable #replayCard here (mirrors buildQuadrant on #rrgQuadrant). */
function buildReplay(_d) {
  const box = document.getElementById("replayCard");
  if (!box) return;
  box.addEventListener("click", onReplayClick);
  box.addEventListener("change", onReplayChange);
  box.addEventListener("pointermove", onReplayScrub);
  box.addEventListener("pointerleave", rpHideHover);
  box.addEventListener("pointercancel", rpHideHover);
}

// Pointer-driven crosshair on the mode-2b replay leg-path (the erp scrub idiom, re-derived
// for the rp frame): replay-chart.js embeds per-day {x, y, readout} + the frame in data-hover;
// this handler only maps pointer x → trading-day band and positions the layer. Parsed payload
// cached on the svg node (renderReplay repaints #replayCard, so each render yields a fresh node).
function rpHideHover() {
  const box = document.getElementById("replayCard");
  if (!box) return;
  for (const layer of box.querySelectorAll(".hover-layer")) layer.setAttribute("visibility", "hidden");
}
/** Parse-and-cache the replay chart's data-hover payload on its (re-render-fresh) svg node. */
function rpHoverPayload(svg) {
  if (!svg.dataset.hover) return null;
  if (!svg.__rpHover) {
    try {
      svg.__rpHover = JSON.parse(svg.dataset.hover);
    } catch {
      return null;
    }
  }
  return svg.__rpHover;
}
/** Position the replay chart's hover layer at trading-day index i (crosshair + held-leg dot
 *  + date/held-leg readout). Days with no drawable y hide the dot but still show the readout. */
function rpPositionHover(svg, i) {
  const layer = svg.querySelector(".hover-layer");
  const hv = rpHoverPayload(svg);
  const d = hv && hv.days[i];
  if (!layer || !d) return;
  layer.querySelector(".xhair").setAttribute("x1", d.x);
  layer.querySelector(".xhair").setAttribute("x2", d.x);
  const dot = layer.querySelector(".hover-dot");
  if (d.y == null) {
    dot.setAttribute("visibility", "hidden");
  } else {
    dot.removeAttribute("visibility");
    dot.setAttribute("cx", d.x);
    dot.setAttribute("cy", d.y);
  }
  const text = layer.querySelector(".hover-read");
  text.textContent = d.r;
  const bg = layer.querySelector(".hover-read-bg");
  const bbox = text.getBBox();
  bg.setAttribute("x", bbox.x - 2);
  bg.setAttribute("y", bbox.y - 1);
  bg.setAttribute("width", bbox.width + 4);
  bg.setAttribute("height", bbox.height + 2);
  layer.setAttribute("visibility", "visible");
}
function onReplayScrub(e) {
  const svg = e.target.closest("svg.rp-chart");
  if (!svg) return rpHideHover();
  const hv = rpHoverPayload(svg);
  const n = hv ? hv.days.length : 0;
  if (!n) return rpHideHover();
  // Letterbox-corrected client x → SVG user x (the scrubIndex idiom on the rp frame),
  // then band mapping: one x-step per trading day, floor not round (bands, not samples).
  const rect = svg.getBoundingClientRect();
  const drawnW = Math.min(rect.width, rect.height * (hv.w / hv.h));
  const xPad = (rect.width - drawnW) / 2;
  const userX = ((e.clientX - rect.left - xPad) / drawnW) * hv.w;
  const i = Math.max(0, Math.min(n - 1, Math.floor(((userX - hv.ml) / hv.pw) * n)));
  rpPositionHover(svg, i);
}

/** The range control: preset chips (1y/3y/5y/10y) + custom start/end date inputs, reflecting
 *  the current module range state. Rebuilt each render; the stable #replayCard owns the
 *  delegated listeners so a rebuild never loses them. */
function replayControlsHtml() {
  const max = todayIso();
  const presets = Object.keys(REPLAY_PRESETS)
    .map(
      (p) =>
        `<button class="rp-preset${replayPreset === p ? " active" : ""}" type="button" ` +
        `data-preset="${p}" aria-pressed="${String(replayPreset === p)}">${esc(p)}</button>`,
    )
    .join("");
  return (
    `<div class="rp-range" role="group" aria-label="Replay range">` +
    `<span class="rp-range-lbl">Range</span>` +
    `<div class="rp-presets">${presets}</div>` +
    `<label class="rp-date-l">from <input type="date" class="rp-date" data-edge="start" value="${esc(replayStart)}" max="${esc(max)}" /></label>` +
    `<label class="rp-date-l">to <input type="date" class="rp-date" data-edge="end" value="${esc(replayEnd)}" max="${esc(max)}" /></label>` +
    `</div>`
  );
}

/** Repaint the replay card: the range control + the server-computed chart (via the pure seam,
 *  fed the cached per-family map for the coverage bar). No engine math — points render as-is. */
function renderReplay(d) {
  const box = document.getElementById("replayCard");
  if (!box) return;
  setHTML(box, replayControlsHtml() + replayChartHtml(d, replayFamilyMembers));
}

/** A preset-chip click: recompute the range from the preset (N years ending today) + refetch
 *  (debounced like a scenario refetch). */
function onReplayClick(e) {
  const chip = e.target.closest("[data-preset]");
  if (!chip) return;
  const yrs = REPLAY_PRESETS[chip.dataset.preset];
  if (yrs == null) return;
  replayPreset = chip.dataset.preset;
  replayEnd = todayIso();
  replayStart = isoYearsAgo(yrs);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fetchReplay, 100);
}

// Client-side mirror of src/lab-request.ts parseReplay's range rules. Constants are LITERAL mirrors
// of REPLAY_MIN_SPAN_DAYS / REPLAY_MAX_YEARS there — input validation only, NO engine
// math. Every server 400 the date inputs can produce (span under the min, start ≥ end,
// cleared input) is caught HERE before fetching, because the fetch's error path must not hide
// the range controls the user needs to fix the range.
const REPLAY_MIN_SPAN_DAYS = 7; // mirror of parseReplay (src/lab-request.ts)
const REPLAY_MAX_YEARS = 10; // mirror of parseReplay (src/lab-request.ts)
function validateReplayRange(start, end) {
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!isDate(start) || !isDate(end)) return "Pick both a start and end date (YYYY-MM-DD).";
  if (start >= end) return "Start date must be before the end date.";
  const spanDays = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000);
  if (spanDays < REPLAY_MIN_SPAN_DAYS) return `Range too short - pick dates at least ${REPLAY_MIN_SPAN_DAYS} days apart.`;
  const minStart = new Date();
  minStart.setUTCFullYear(minStart.getUTCFullYear() - REPLAY_MAX_YEARS);
  minStart.setUTCDate(minStart.getUTCDate() - 1);
  const earliest = minStart.toISOString().slice(0, 10);
  if (start < earliest) return `Start date can't be older than ${REPLAY_MAX_YEARS} years (earliest ${earliest}).`;
  return null;
}

/** Render a short inline error INSIDE #replayCard, ABOVE the still-visible range controls,
 *  and fetch NOTHING. Replay mode must NEVER hide the range controls: calling message() would
 *  hide #lab entirely, leaving no way to fix the range and re-entering replay would refetch the
 *  same bad module-state range. Used for both client-side range validation (onReplayChange) and
 *  replay fetch/server errors (fetchReplay). */
function showReplayError(msg) {
  const box = document.getElementById("replayCard");
  if (!box) return;
  // The error `<p>` is title-free, but it is concatenated with the SAME `replayControlsHtml()`
  // producer the normal repaint (renderReplay) writes through the seam — so this path routes
  // through it too, or a `title=` added to the controls would be glyphless on the error render only.
  setHTML(box, `<p class="rp-error" role="alert">${esc(msg)}</p>` + replayControlsHtml());
  document.getElementById("message").hidden = true;
  document.getElementById("lab").hidden = false;
}

/** A date-input edit: switch to a custom range (clear the preset). Validate the range client-side
 *  (mirroring the server) BEFORE fetching — an invalid range renders inline above the controls and
 *  skips the fetch, so a user-reachable 400 never bricks the card. */
function onReplayChange(e) {
  const inp = e.target.closest("input[data-edge]");
  if (!inp) return;
  replayPreset = null;
  if (inp.dataset.edge === "start") replayStart = inp.value;
  else replayEnd = inp.value;
  clearTimeout(debounceTimer);
  const err = validateReplayRange(replayStart, replayEnd);
  if (err) return showReplayError(err);
  debounceTimer = setTimeout(fetchReplay, 100);
}

/** Replay branch of applyBoard: render the replay card + hide every live/scenario section via
 *  the per-mode visibility map (applyVisibility handles the replay case). The bench is normally
 *  built by the live/scenario landing; if replay is somehow reached first, a standalone
 *  #replayCard is injected (built stays false so a later Live/Scenario switch rebuilds it). */
function applyReplay(d) {
  if (!built && !document.getElementById("replayCard")) {
    const lab = document.getElementById("lab");
    // ALLOWLISTED raw write: an empty host element, no `title=` and no content to decorate — the
    // markup that fills it is written by renderReplay through the seam.
    lab.innerHTML = `<section class="replay-card" id="replayCard" aria-label="Historical replay"></section>`;
    buildReplay(d);
  }
  renderReplay(d);
  document.getElementById("message").hidden = true;
  document.getElementById("lab").hidden = false;
  applyVisibility({ mode: "replay" });
  syncUrl();
  cacheLastD(d);
}

/* ============================================================ IN-PLACE UPDATE */

/** L1: upsert/remove the `INTRADAY · <date>` chip on `.bp-floors-title`, `.board-head` and `.df-head`. Text +
 *  title only (R3: text-only label), so the paint needs no markup seam. */
function paintIntradayVerdictChips(d) {
  const label = intradayVerdictLabel(d);
  for (const sel of [".bp-floors-title", ".board-head", ".df-head"]) {
    const head = document.querySelector(sel);
    if (!head) continue;
    let chip = head.querySelector(":scope > .intraday-verdict");
    if (!label) {
      if (chip) chip.remove();
      continue;
    }
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "intraday-mark intraday-verdict";
      head.appendChild(chip);
    }
    chip.title = label.title;
    chip.textContent = label.text;
  }
}

/** The #dfFoot write: breaker/default base + overlays + the cash chip + feed-lag. Re-run alone
 *  (`paintLive`) when the exposure weight lands after the board painted. */
let lastFoot = null;
function paintFoot(d, breaker) {
  const dfFoot = document.getElementById("dfFoot");
  if (!dfFoot) return;
  const base = breaker ? breakerFootHtml(d) : dfFootDefault; // shared producer (lab-board.js) — /overview flips the same footer
  // The single resolved cash claim. Precedence lives in the pure seam module: a `cash`
  // R4 and a standing `partial` overlay CAN both hold, and the seam resolves that pair to level
  // `full` by unconditional R4 dominance — which is why only one PAINTS, not because the pair is
  // unreachable. NB `full` is `CashState.level`, the resolver's output;
  // `R4Result` has no such field, only `cash`/`phase`. `d.cashOverlay` is LIVE-ONLY
  // (absent on scenario/replay) and absent renders exactly as `off`.
  // The cash-claim precedence seam still speaks R4's persisted shape
  // ({cash, phase, reason}), which the wire no longer carries verbatim.
  // Derive it from the r4 OverlayView — values only, behaviour identical:
  //   · tone === "alert" IS r4.cash (src/lab-overlays.ts's r4View sets alert iff cash);
  //   · the "phase" field is the phase verbatim ("—" when null, which matches no branch);
  //   · note is the server `reason` (absent when empty — the LIVE path hardcodes reason:"").
  // R4's `full` still suppresses the overlay's `partial`.
  const r4o = d.overlays?.r4;
  const r4Claim = r4o
    ? { cash: r4o.tone === "alert", phase: overlayFieldValue(r4o, R4_PHASE_LABEL), reason: r4o.note || "" }
    : null;
  // `equityPct` (the push's scalar, live board only) is the last SETTLED weight: a re-poll paints the prior one
  // until the new read lands; null (the unsized chip) before the first settle and after a failed read.
  // The feed-lag footnote hangs off the SAME footer and is appended HERE, after
  // the breaker override, so a breaker run does not silently drop the lag evidence.
  setHTML(
    dfFoot,
    base +
      overlayStripHtml(d.overlays) +
      cashClaimHtml(r4Claim, d.cashOverlay, exposureEquity.value) +
      feedLagFoot(d.feedLag),
  );
}

function applyBoard(d) {
  lastFoot = null; // only a board this call paints may have its footer re-run (paintLive)
  if (d.mode === "replay") return applyReplay(d);
  // Anti-fake-calm (live only): with NO live feed this run the mean contribution (0)
  // would paint a misleading "Calm / rung 1". Show a no-data state instead.
  if (d.liveFamilyCount === 0) {
    message("No live family feeds in the latest run - danger can't be assessed.");
    return;
  }
  if (!built) buildBench(d);

  const card = METHOD_CARDS.find((c) => c.id === selectedMethodId) || null;
  // R4's cash breaker flips the ledger footer to the Cash override via a DUAL driver:
  //  · scripted — the selected method-card browse overlay carries cashBreaker;
  //  · computed — Live / hand-cycled ?s= scenarios (methodDrivesBoard false) where the server's
  //    R4 leaf resolved cash. No client engine math: the r4 overlay's tone is precomputed by
  //    /api/lab — `r4View` sets tone "alert" IFF `r4.cash`.
  //    ⚠ SECOND consumer of the `OverlayView.tone` enum, alongside overlay-strip.js's `TONES`
  //    allowlist — and the contract test's enum-sync check pins only that one. Widening the enum
  //    can't break this equality, but if a future tone should ALSO mean "in cash", this line needs
  //    the same edit and nothing links them. Grep `tone ===` before adding a tone.
  const scriptedBreaker = methodDrivesBoard && !!card?.cashBreaker;
  const computedBreaker = !methodDrivesBoard && d.overlays?.r4?.tone === "alert";
  const breaker = scriptedBreaker || computedBreaker;
  const t1 = d.t1dial;
  const displayLadder = [...d.ladder, "Cash"];
  const redLabels = d.globalFamilies.filter((f) => f.state === "RED").map((f) => f.label);
  // Firing headline must reflect the GLOBAL panel (matching the now-global tiles + T1 dial),
  // not the US-panel top-level d.firingCount/d.liveFamilyCount. Mirror families.ts's exact
  // predicate: firingCount = live families with f.firing (= live && state !== "GREEN").
  const gLive = d.globalFamilies.filter((f) => f.live).length;
  const gFiring = d.globalFamilies.filter((f) => f.firing).length;
  // D1/D2 — elevated members that cannot arm ANY family (band-driving excluded them). A board that is
  // calm ONLY because these can't arm is a different sentence to a genuinely calm one (lab-reader).
  const cannotArmN = d.globalFamilies.reduce((n, f) => n + (f.cannotArm ? f.cannotArm.count : 0), 0);

  // --- families board: build-once skeleton + in-place head/tile update, moved to the
  // families-board.js seam. `interactive: true` = /lab's scenario tap-cycle affordances
  // (the delegated listeners live below on #lab); /overview calls it with no deps. ---
  renderFamiliesBoard(document.getElementById("familiesBoard"), d, { interactive: true });
  // BAND column: the read-time escalator recompute served under
  // `d.band` (LIVE ONLY). Scenario/replay carry no `band`, so renderBandPanel returns "" and
  // the host stays blank — same live-only pattern as the EW badge / bandReason above.
  // The section's micro-label rides INSIDE the host innerHTML (band-panel.js
  // owns the panel markup and is out of this rung's scope), and only when the panel actually
  // renders — an empty host must stay `:empty` so `.band-panel-host:empty { display: none }`
  // still collapses it in scenario/replay. The tag is absolutely positioned (lab.html
  // `.lg-sectag`), so it adds nothing to the host's box.
  // `buildBandPanel` paints NO markup (it only wires the delegated click), so this host is empty when
  // the build-time `decorateHelp(lab)` runs — the escalator floor and member `[title]`s have never
  // carried a ⓘ on any render.
  const bandHtml = renderBandPanel(d.band);
  setHTML($("#bandPanelHost"), bandHtml ? `<span class="lg-sectag" aria-hidden="true">Alert band</span>${bandHtml}` : "");
  // L1: the INTRADAY verdict chip on the three landing-view heads (floors title, board head, ledger head) —
  // upserted by id so a re-render neither duplicates nor strands it; removed on an EOD payload.
  paintIntradayVerdictChips(d);

  // --- reactive sections: every section is a pure projection of the current d.
  // resolveField runs ONCE here and feeds
  // all three renderers. renderDangerField also recomputes dfFootDefault, which the breaker
  // block below reads — so these must run before that block. lastField/lastD are cached for
  // the no-refetch quadrant re-render. ---
  const field = resolveField(d);
  renderDangerField(field, d);
  renderStructureMap(field);
  renderQuadrant(field, d);
  renderScoreboard(d.scoreboard);
  cacheLast(field, d);
  // Cache the per-family {label, ids[], state} map for the replay coverage bar (ReplayResponse
  // carries no family panel — replay reuses this last live/scenario map). Derived exactly as
  // the seam's contract specifies: globalFamilies → {label, ids:[member.id], state}; state
  // colors each family's coverage strip.
  // `key` is additive: the coverage bar reads label/ids/state, the
  // compare-indicator picker needs the family KEY to bucket an option id. Same cache, no
  // second derivation of family membership.
  replayFamilyMembers = (d.globalFamilies || []).map((f) => ({
    key: f.key,
    label: f.label,
    ids: (f.members || []).map((m) => m.id),
    state: f.state,
  }));

  // --- danger ledger: R4 breaker override of the footer + held highlight ---
  // The ledger is built once (frozen snapshot); only its footer + the in-band held
  // highlight react to the breaker here. On breaker the footer flips to the Cash override
  // and #dangerField.breaker drops the in-band sleeve's held styling.
  const dangerField = document.getElementById("dangerField");
  if (dangerField) dangerField.classList.toggle("breaker", breaker);
  // The COVERAGE legend line — the `⊗` badges' justification. Its OWN
  // always-visible line under the ledger head, deliberately OUTSIDE `#dfLegend`: it is a LIVE
  // READING of an active degradation, not reference copy, so the legend disclosure must never
  // swallow it (pinned by `lab-board.test.js`). Set on EVERY board update (the line's host
  // is skeleton, painted once), and "" whenever the run's coverage was clean, so a healthy board keeps
  // exactly the legend it had. The feed symbol and the age both ride the served coverage mark —
  // recorded on the run that pushed this dial. NEVER `d.feedLag`: that is a REQUEST-path measurement
  // (and a lag, not the lag age the coverage floor keys on), so it prints a number the run never saw
  // once the cron pauses or the alert row is not today's.
  // Members are NAMED from `dangerModel.memberLabel` — the same id→label map the feed-lag footnote
  // uses — so the line reads `MOVE`, never the registry id or the raw feed symbol (`BAMLC0A0CM`).
  const flipLegend = document.getElementById("dfFlipLegend");
  if (flipLegend) {
    setHTML(flipLegend, coverageLegendHtml(d.coverage, (dangerModel && dangerModel.memberLabel) || {}));
  }
  lastFoot = [d, breaker];
  paintFoot(d, breaker);
  // The feed-lag disclosure sits beside the footnote in #dfBelow. Repainted every poll from the
  // lazy state; the roster loads only when the user first expands it (onFeedLagToggle).
  renderFeedLagPanel();

  // R4 knob chips always mirror the current `scenario` (incl. after a card preset overwrote it).
  renderR4Knobs();

  // --- reader (computed from the selected method + the current board d) ---
  const held = breaker ? 10 : t1.targetRung; // no flat veto now: held === the dial's rung
  renderReader(card, {
    regime: t1.regime,
    danger: t1.dangerScore,
    firing: gFiring,
    cannotArm: cannotArmN,
    liveCount: gLive,
    target: t1.targetRung,
    held,
    dialHeld: t1.targetRung,
    breaker,
    redLabels,
    ladder: displayLadder,
  });

  document.getElementById("message").hidden = true;
  document.getElementById("lab").hidden = false;

  // --- per-section visibility (reads the CURRENT mode's persisted map) ---
  applyVisibility(d);

  // --- keep the address bar in sync so any board state is copyable / deep-linkable ---
  syncUrl();
}


/* ============================================================ SELECTION / MODE */

/** A picker-chip click: the method drives the board (Scenario preset) + opens in the reader. */
function select(id) {
  const card = METHOD_CARDS.find((c) => c.id === id);
  if (!card) return;
  selectedMethodId = id;
  scenario = { ...card.preset };
  methodDrivesBoard = true; // enables the Cash breaker overlay for R4
  clearTimeout(debounceTimer); // kill any pending knob/tile debounce before this immediate fetch
  document
    .querySelectorAll("#picker .chip-m")
    .forEach((r) => r.setAttribute("aria-current", String(r.dataset.id === id)));
  setMode("scenario");
}

/** Reflect the active mode on the stable (out-of-#lab) toggle. */
function updateToggle() {
  for (const btn of document.querySelectorAll("#modebar button")) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
}

/** Cycle a family's scenario state per the seeding rule and refetch (debounced). */
function cycleFamily(key) {
  // A hand-cycle is not method-driven ⇒ the Cash breaker stays off (held floors at 9).
  methodDrivesBoard = false;
  const cur = scenario[key];
  let next;
  if (key === "dispersion") {
    // the one absent-able family: off → GREEN → AMBER → RED → off
    next = cur === undefined ? "GREEN" : cur === "GREEN" ? "AMBER" : cur === "AMBER" ? "RED" : undefined;
  } else {
    // live families are always present, default GREEN: GREEN → AMBER → RED → GREEN
    const c = cur ?? "GREEN";
    next = c === "GREEN" ? "AMBER" : c === "AMBER" ? "RED" : undefined; // undefined = back to GREEN (absent)
  }
  if (next === undefined) delete scenario[key];
  else scenario[key] = next;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fetchScenario, 100);
}

/* ------------------------------------------------- R4 breaker knobs (tail · sustained · cash-days)
 * A dim, dashed chip row under the family tiles: the three R4 breaker inputs the server
 * parses out of `?s=` (tail:0|1, sustained:0|1, daysInCash:<int>). Unlike the family tiles
 * these are NOT family states — they're breaker knobs, so they read dimmer/bordered. Each
 * click mirrors cycleFamily exactly: methodDrivesBoard=false, mutate `scenario`, debounce →
 * fetchScenario. `scenario.tail="1"` serializes as `…,tail:1` for free via scenarioQuery. */
const R4_KNOBS = [
  { key: "tail", name: "tail" },
  { key: "sustained", name: "sustained" },
  { key: "daysInCash", name: "cash-days" },
];
/** A knob's current value read straight off `scenario` → { on, label }. tail/sustained are
 *  boolean ("1"); daysInCash cycles off→5→20→off. Always reflects the live `scenario`, so a
 *  method-card preset that overwrites `scenario` re-paints these correctly (renderR4Knobs is
 *  called each applyBoard). */
function knobView(key) {
  if (key === "daysInCash") {
    const d = scenario.daysInCash;
    return { on: d != null, label: d != null ? `${d}d` : "off" };
  }
  const on = scenario[key] === "1";
  return { on, label: on ? "on" : "off" };
}
/** Repaint the knob chips from the current `scenario` (idempotent; safe every applyBoard). */
function renderR4Knobs() {
  const el = document.getElementById("r4knobs");
  if (!el) return;
  // Live mode ignores the knobs — `scenario` may still hold a residual toggle from a prior
  // scenario session, so force every chip to the "off" appearance (dimmed row) rather than
  // reading stale state. Chips stay clickable; a click enters scenario mode (toggleKnob).
  const live = mode !== "scenario";
  el.classList.toggle("dim", live);
  const knobsHtml =
    `<span class="r4k-lbl">R4 ⌁</span>` +
    R4_KNOBS.map(({ key, name }) => {
      const view = knobView(key);
      const on = live ? false : view.on;
      const label = live ? "off" : view.label;
      // cash-days is tri-state (off/5d/20d); aria-label carries the value, so no aria-pressed.
      const pressed = key === "daysInCash" ? "" : ` aria-pressed="${on}"`;
      return (
        `<button class="chip-k${on ? " on" : ""}" type="button" data-knob="${key}"` +
        `${pressed} aria-label="${esc(name)} breaker knob - ${esc(label)}">` +
        `<span class="ck-id">${esc(name)}</span><span class="ck-v">${esc(label)}</span></button>`
      );
    }).join("");
  setHTML(el, knobsHtml);
}
/** Toggle one R4 knob and refetch (debounced), reusing the cycleFamily path. tail/sustained
 *  flip boolean; daysInCash cycles off→5→20→off. A knob click enters scenario mode if we're
 *  live (setMode fetches immediately); already-scenario debounces like a hand-cycle. */
function toggleKnob(key) {
  methodDrivesBoard = false;
  if (key === "daysInCash") {
    const cur = scenario.daysInCash;
    const next = cur === undefined ? "5" : cur === "5" ? "20" : undefined;
    if (next === undefined) delete scenario.daysInCash;
    else scenario.daysInCash = next;
  } else {
    if (scenario[key] === "1") delete scenario[key];
    else scenario[key] = "1";
  }
  renderR4Knobs(); // instant visual feedback; applyBoard re-paints after the fetch too
  if (mode !== "scenario") {
    setMode("scenario"); // fetches immediately + syncs the mode toggle
  } else {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fetchScenario, 100);
  }
}

/** Cycle ONE indicator's scenario state (per-leg what-if toggle): GREEN → AMBER → RED →
 *  (cleared = back to its family's base). Stored in the same `scenario` map keyed by the
 *  indicator id — a namespace disjoint from family keys — so the server derives the family
 *  worst-of. A method preset ({...card.preset}) clears these along with family overrides. */
function cycleMember(id) {
  methodDrivesBoard = false;
  const cur = scenario[id] ?? "GREEN";
  const next = cur === "GREEN" ? "AMBER" : cur === "AMBER" ? "RED" : undefined;
  if (next === undefined) delete scenario[id];
  else scenario[id] = next;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fetchScenario, 100);
}

function scenarioQuery() {
  return Object.entries(scenario)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

/** Inverse of scenarioQuery: parse a `k:v,k:v` `?s=` string into a `scenario` overrides map.
 *  Everything stays a string ("RED" / "1" / "5"), exactly as scenarioQuery emits and the knob
 *  renderers / cycleFamily expect — so a deep-link round-trips byte-for-byte. */
function parseScenarioQuery(s) {
  const out = {};
  for (const pair of String(s).split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/** Two-way URL sync: mirror the scenario's family/knob overrides — and ONLY those — into `?s=`, so a
 *  deep-link restores the scenario board, not the whole UI. Purely local selections are deliberately
 *  NOT serialized (the selected method card, `selectedMethodId`, is the live example): a shared link
 *  reopens the reader on the default card. The `s` value keeps colons/commas literal (`?s=volatility:RED,trend:RED`) —
 *  both are legal unencoded in a query value — so the URL stays human-readable; only genuinely
 *  unsafe chars are escaped. The read side (URLSearchParams.get) decodes both this form and the
 *  old `%3A/%2C` links, so pre-existing encoded deep-links still round-trip. Foreign query params
 *  + the hash are preserved. Live mode / an empty scenario strips `?s=` to keep the URL clean.
 *  replaceState (no history spam) and a diff-guard (no redundant writes). Called at the end of
 *  every applyBoard. */
function syncUrl() {
  const q = scenarioQuery();
  // Preserve foreign query params + the hash via URLSearchParams, but hand-append our own `s`
  // segment so its colons/commas stay literal (URLSearchParams.set would percent-encode them).
  const params = new URLSearchParams(location.search);
  params.delete("s");
  const foreign = params.toString();
  // encodeURIComponent escapes everything unsafe, then restore `:`/`,` to their readable literals.
  const sSeg = mode === "scenario" && q ? `s=${encodeURIComponent(q).replace(/%3A/gi, ":").replace(/%2C/gi, ",")}` : "";
  const qs = [foreign, sSeg].filter(Boolean).join("&");
  const next = location.pathname + (qs ? `?${qs}` : "") + location.hash;
  if (location.pathname + location.search + location.hash !== next) history.replaceState(null, "", next);
}

/** `&walk=N` suffix from the current URL's `?walk=` param (empty when absent/0). Forwarded to the
 *  handler by both the live and scenario fetches so `/lab?walk=N` and `/lab?s=…&walk=N` compose.
 *  `syncUrl` preserves it as a foreign param, so it survives scenario-mode URL rewrites.
 *
 *  `defaultDays` applies ONLY when the URL names no `?walk=` at all. A PRESENT param always wins,
 *  including `?walk=0` — that is the explicit "no walk" the scenario default must not override
 *  (0 is falsy, so this reads the param's PRESENCE, never its truthiness). The scenario fetch
 *  passes `SCENARIO_WALK_DAYS`; the live fetch passes nothing and keeps its prior behaviour. */
function walkParam(defaultDays = 0) {
  const raw = new URLSearchParams(location.search).get("walk");
  const n = raw != null ? Number.parseInt(raw, 10) : defaultDays;
  return Number.isFinite(n) && n > 0 ? `&walk=${n}` : "";
}

async function fetchScenario() {
  const gen = ++fetchGen;
  const dmReady = loadDangerModel(fetchOnce); // parallel with the board fetch; cached after the first
  try {
    // The scenario fetch DEFAULTS the walk: the held-leg trajectory is the second half of
    // a `?s=` flip's consequence, so it must paint without a hand-typed `?walk=`.
    const data = await getJson(`/api/lab?s=${encodeURIComponent(scenarioQuery())}${walkParam(SCENARIO_WALK_DAYS)}`, { timeoutMs: API_TIMEOUT_MS });
    if (gen !== fetchGen) return; // a newer fetch already superseded this one
    await dmReady; // ensure the danger-model block is loaded before decorateCell runs
    if (gen !== fetchGen) return;
    applyBoard(data);
  } catch (err) {
    if (gen !== fetchGen) return;
    message(`Could not load the scenario: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchLive() {
  const gen = ++fetchGen;
  const dmReady = loadDangerModel(fetchOnce); // parallel with the board fetch; cached after the first
  const expReady = exposureEquity.load(); // re-issued per poll (current state, not a constant table)
  try {
    const res = await request("/api/lab?hist=" + LOOKBACK + walkParam(), { fetchImpl: liveFetch, timeoutMs: API_TIMEOUT_MS });
    if (gen !== fetchGen) return;
    if (res.status === 404) {
      message("No cron run recorded yet - the panel appears after the first run. (Scenario mode still works.)");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (gen !== fetchGen) return;
    // The board paints on dmReady; the exposure weight only re-sizes the footer chip (never rejects).
    await paintLive({
      data,
      dmReady,
      expReady,
      isCurrent: () => gen === fetchGen,
      paintBoard: applyBoard,
      paintFoot: () => lastFoot && paintFoot(...lastFoot),
    });
  } catch (err) {
    if (gen !== fetchGen) return;
    message(`Could not load the panel: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Fetch the historical-replay leg-path for the current range. Mirrors fetchLive/fetchScenario's
 *  monotonic fetch-token guard (a slower earlier response can't clobber a newer render). No
 *  danger-model load needed: replay renders no signal grid, and the coverage bar reads the
 *  cached live family map. */
async function fetchReplay() {
  const gen = ++fetchGen;
  try {
    const data = await getJson(`/api/lab?replay=${encodeURIComponent(`${replayStart}:${replayEnd}`)}`, { timeoutMs: API_TIMEOUT_MS });
    if (gen !== fetchGen) return;
    applyBoard(data);
  } catch (err) {
    if (gen !== fetchGen) return;
    // Render inside #replayCard above the still-visible controls — NEVER message() (it hides
    // #lab, taking the range controls with it and bricking replay until a page reload).
    showReplayError(`Could not load the replay: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setMode(m) {
  if (m !== "live" && m !== "scenario" && m !== "replay") return;
  // Entering scenario (transition from a non-scenario mode) starts momentum flat: scnMomentum is
  // a manual what-if knob, so it must not carry over from a prior scenario session or leak in.
  if (m === "scenario" && mode !== "scenario") resetScnMomentum();
  mode = m;
  updateToggle();
  // Reflect the new mode's visibility map immediately (chips + section classes), before the async
  // fetch returns; applyBoard re-applies it with the real d at the end of the render.
  applyVisibility({ mode: m });
  if (m === "scenario") fetchScenario();
  else if (m === "replay") fetchReplay();
  else fetchLive();
}

function message(text) {
  const el = document.getElementById("message");
  el.textContent = text;
  el.hidden = false;
  document.getElementById("lab").hidden = true;
}

function onModebarClick(e) {
  const modeBtn = e.target.closest("[data-mode]");
  if (!modeBtn) return;
  // A manual mode toggle is a hand-driven view, not a method firing ⇒ breaker off.
  methodDrivesBoard = false;
  setMode(modeBtn.dataset.mode);
}

// Apply the current mode's visibility map: #lab.collapsed for cards (reuses the full-width-board
// layout) + .is-hidden on the other 3 section wrappers. Also reflects chip active state. Runs at the
// end of applyBoard and on mode switch (reading d.mode / the mode being entered).
function applyVisibility(d) {
  const isReplay = d.mode === "replay";
  // Replay owns #lab: show ONLY the replay card, hide the bench (board+reader) + every
  // live/scenario section — regardless of the (live/scenario) persisted map. Switching back to
  // live/scenario runs the branch below and restores that mode's map.
  const bench = document.querySelector("#lab .bench");
  if (bench) bench.classList.toggle("is-hidden", isReplay);
  const replayCard = document.getElementById("replayCard");
  if (replayCard) replayCard.classList.toggle("is-hidden", !isReplay);
  if (isReplay) {
    document.getElementById("lab").classList.remove("collapsed", "board-hidden");
    for (const id of VIS_HIDEABLE) {
      const el = document.getElementById(id);
      if (el) el.classList.add("is-hidden");
    }
    // The visbar chips gate live/scenario sections only — hide the whole SHOW group here
    // (dead controls don't render in History mode); switching back re-shows it below.
    const visGroup = document.querySelector("#visbar")?.closest(".strip-group");
    if (visGroup) visGroup.classList.add("is-hidden");
    return;
  }
  const visGroup = document.querySelector("#visbar")?.closest(".strip-group");
  if (visGroup) visGroup.classList.remove("is-hidden");
  const map = visibleByMode[d.mode] || VIS_DEFAULTS[d.mode] || VIS_DEFAULTS.live;
  document.getElementById("lab").classList.toggle("collapsed", !map.cards);
  // Board hidden ⇒ single-column bench (no empty board sliver next to the reader); with
  // cards ALSO hidden the bench has no visible children and collapses to zero height.
  document.getElementById("lab").classList.toggle("board-hidden", !map.familiesBoard);
  for (const id of VIS_HIDEABLE) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("is-hidden", !map[id]);
  }
  // Re-entry block: the default leg fetched only on the first toggle-on (off by default), painted once.
  const reentry = document.getElementById("reentry");
  if (map.reentry && reentry && !reentry.dataset.leg) paintReentry(reentry, DEFAULT_REENTRY_LEG);
  for (const btn of document.querySelectorAll("#visbar button")) {
    const on = !!map[btn.dataset.section];
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  }
}

// Re-entry leg: fetch (cached per leg) and paint; a stale fetch never overwrites a newer pick.
function paintReentry(el, leg) {
  el.dataset.leg = leg;
  loadReentry(leg).then((live) => {
    if (el.dataset.leg === leg) setHTML(el, renderReentry(live, leg, readOpenState(safeStorage())));
  });
}
// Each remembered <details> (REENTRY_TOGGLES) survives leg switches and reloads. `toggle` does not bubble — bound in the capture phase on document.
function onReentryToggle(e) {
  const t = REENTRY_TOGGLES.find((t) => e.target.matches?.(`#reentry .${t.cls}`));
  if (t) writeOpen(safeStorage(), t.key, e.target.open);
}
function safeStorage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
// Delegated from document: #reentry is (re)built inside the shell's innerHTML, after listeners bind.
function onReentryClick(e) {
  const btn = e.target.closest("#reentry [data-leg]");
  const el = btn?.closest("#reentry");
  if (el && btn.dataset.leg !== el.dataset.leg) paintReentry(el, btn.dataset.leg);
}

// A visibility-chip click: flip the CURRENT mode's section flag, persist, re-apply (per mode).
function onVisbarClick(e) {
  const btn = e.target.closest("[data-section]");
  if (!btn) return;
  const key = btn.dataset.section;
  // Replay mode has no persisted visibility map (its sections are all force-hidden); the visbar
  // chips are inert there, so ignore a stray click rather than dereference an absent map.
  const map = visibleByMode[mode];
  if (!map) return;
  map[key] = !map[key];
  try {
    localStorage.setItem(VIS_KEY, JSON.stringify(visibleByMode));
  } catch {
    /* private-mode / quota — visibility stays session-local, still applied below */
  }
  applyVisibility({ mode });
}

function onClick(e) {
  // R4 breaker knobs (dim chip row under the tiles) — clickable in any mode; a click enters
  // scenario mode (via toggleKnob) if we're live.
  const knob = e.target.closest("[data-knob]");
  if (knob) return toggleKnob(knob.dataset.knob);
  const t = e.target.closest(".tile.clickable");
  if (!t) return;
  // A click on a member leg cycles just that indicator; empty tile area cycles the family.
  const leg = e.target.closest(".ids [data-id]");
  if (leg) return cycleMember(leg.dataset.id);
  if (t.dataset.key) cycleFamily(t.dataset.key);
}

function onKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const knob = e.target.closest("[data-knob]");
  if (knob) {
    e.preventDefault();
    return toggleKnob(knob.dataset.knob);
  }
  const t = e.target.closest(".tile.clickable");
  if (!t) return;
  const leg = e.target.closest(".ids [data-id]");
  if (leg) {
    e.preventDefault();
    return cycleMember(leg.dataset.id);
  }
  if (t.dataset.key) {
    e.preventDefault();
    cycleFamily(t.dataset.key);
  }
}

/* ------------------------------------------------- SECTION TOGGLE
 * Top strip switching the whole lab body between the existing Families view (default) and
 * the new Episode-replay view. ORTHOGONAL to the Live/Scenario/Replay mode (that is the
 * 9-leg replay, owned by applyBoard/applyVisibility) — this only shows one of two DOM
 * clusters. Choice persists in localStorage `lab.section` (alongside `lab.visible`). The
 * episode chart is a pure projection (exposure-replay-chart.js); ONE /api/replay fetch on
 * first open, then episode switches re-render client-side. */
const SECTION_KEY = "lab.section";
function loadSection() {
  try {
    return localStorage.getItem(SECTION_KEY) === "episodes" ? "episodes" : "families";
  } catch {
    return "families";
  }
}
let labSection = loadSection();
// /api/replay payload cached on first open (all episodes in one shot); switching episodes
// re-renders from this cache with zero refetch.
let replayEpisodesPayload = null;
let replayEpisodeSelected = null;
async function ensureEpisodesLoaded() {
  if (replayEpisodesPayload) return;
  // Through apiFetch, like every gated /api read on this page.
  const res = await request("/api/replay", { fetchImpl: apiFetch, timeoutMs: API_TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  replayEpisodesPayload = await res.json();
  const eps = (replayEpisodesPayload && replayEpisodesPayload.episodes) || [];
  // Default = MOST RECENT episode by start — never "first chip";
  // the picker itself is ordered chronologically (oldest first).
  replayEpisodeSelected = defaultEpisodeId(eps);
}
// --- Companion overlay: the picked companion's line draws ON the replay
// chart's price panel (own left y-scale).
// One range fetch per (episode, indicator) pick, cached; external picks (the four
// EXTERNAL_COMPANIONS, no stored history) route to /api/replay?companion=, stored
// dashboard indicators to /api/series — companionSeriesUrl decides. A resolved fetch
// re-renders the WHOLE chart with the series passed into exposureReplayChartHtml. ---
let companionIndicatorId = null;
const companionSeriesCache = new Map(); // `${episodeId}:${indicatorId}` → series payload
// Fetch-state guard: only the CURRENT pick's fetch may paint (a stale resolve lands in
// the cache but repaints nothing). status ∈ "loading" | "error".
let companionFetch = null; // { key, status, message? } | null

// Stored indicators are picker-eligible only when their history reaches the ≥2015 horizon — read
// ONCE (lazily, on first episode render) off the /indicators payload's per-id `companionAnchorDate`
// (P4), replacing the 62 one-point /api/series probes. Until it resolves the picker offers just the
// four external companions, then re-renders once with the eligible stored ids appended; the option
// label is the `label` field on each served meta.
let storedCompanionOptions = null; // null = unresolved; [] = resolved, none eligible
let storedCompanionProbe = null;
function ensureStoredCompanionsProbed() {
  if (storedCompanionProbe) return;
  storedCompanionProbe = getJson("/api/indicators", { timeoutMs: API_TIMEOUT_MS })
    .catch(() => []) // unreachable payload = no stored companions — never a thrown load
    .then((metas) => {
      storedCompanionOptions = eligibleStoredCompanions(metas, Object.keys(INDICATOR_DESC));
      renderEpisodeReplay();
    });
}
// The served card grouping + RENDER RANK (`/api/families`, openapi `FamilyMeta` — ranked members,
// then that family's card-only overlay ids, then the synthetic non-family zones). Fetched ONCE,
// cached module-level, exactly like `dangerModel`; `[]` until it resolves, and a failed fetch
// leaves it `[]` so the picker degrades to the coverage-bar panel below rather than crashing.
let servedFamilies = [];
let servedFamiliesReady = null;
function loadServedFamilies() {
  if (!servedFamiliesReady) {
    servedFamiliesReady = getJson("/api/families", { timeoutMs: API_TIMEOUT_MS })
      .then((f) => {
        servedFamilies = Array.isArray(f) ? f : [];
        if (servedFamilies.length) renderEpisodeReplay(); // repaint the picker with real headings
      })
      .catch(() => {
        servedFamilies = [];
      });
  }
  return servedFamiliesReady;
}
/** The compare-indicator list groups by family, in the same
 *  impact rank as every other surface.
 *
 *  Family membership + rank come from `servedFamilies` (`/api/families`) —
 *  never a hand-typed member list mirroring `src/families.ts` (a known defect class here).
 *  The `replayFamilyMembers` fallback below (the `d.globalFamilies` coverage-bar cache)
 *  carries MEMBERS only: the `INDICATOR_DESC` keys in no
 *  global family (`BAA10Y`, `VIX`/`VIX3M`, `DB_SMH`/`DB_XLK`, `F7`, `NVDA`, `SPY`,
 *  `DEXUSEU`, `SP500IT`)
 *  all land under "Other indicators" there while the Dashboard
 *  gives the same ids a real heading via `cardGroupOf`. The served render rank carries that
 *  overlay, so an overlay card reads its zone heading on BOTH surfaces — `CQS` reads "Credit"
 *  off its real `GLOBAL_FAMILIES.credit` seat (EU2, the last card-only credit id, was removed 2026-09-05)
 *  (pinned: picker-groups.test.js of `CQS`, NOT of `BAA10Y` — BAA10Y has no card group).
 *  With neither source loaded the picker falls back to the flat list, which
 *  `companionPickerHtml` still renders.
 *
 *  The four EXTERNAL_COMPANIONS are raw market series, not registry indicators: no family, no
 *  rank. They keep their own group, first, so the existing pick stays where the hand expects it. */
const companionOptions = () => {
  const stored = storedCompanionOptions || [];
  const externals = { key: "__ext", label: "Market series", items: EXTERNAL_COMPANIONS };
  const fams = servedFamilies.length ? servedFamilies : replayFamilyMembers;
  if (!fams.length) return EXTERNAL_COMPANIONS.concat(stored);
  const familyOf = new Map();
  // FIRST group claiming an id wins — the same precedence `groupMetasByFamily` applies when it
  // buckets, and the same one `cardGroupOf` applies server-side (family before overlay).
  for (const f of fams) for (const id of f.ids || []) if (!familyOf.has(id)) familyOf.set(id, f.key);
  const metas = stored.map((o) => ({ ...o, family: familyOf.get(o.id) }));
  return groupMetasByFamily(metas, fams, {
    lead: externals,
    otherLabel: "Other indicators",
  });
};

/** Fetch one (episode, indicator) series into the cache, then repaint IF that pick is
 *  still current — a pick or episode switch mid-fetch drops the late paint (the payload
 *  stays cached for a revisit). */
async function fetchCompanionSeries(key, ep, id) {
  try {
    const res = await request(companionSeriesUrl(id, ep.start, ep.end), { fetchImpl: apiFetch, timeoutMs: API_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    companionSeriesCache.set(key, await res.json());
    if (companionFetch && companionFetch.key === key) companionFetch = null;
  } catch (err) {
    if (companionFetch && companionFetch.key === key) {
      companionFetch = { key, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
  if (key === `${replayEpisodeSelected}:${companionIndicatorId}`) renderEpisodeReplay();
}
function renderEpisodeReplay() {
  const host = document.getElementById("episodeReplay");
  if (!host) return;
  const eps = (replayEpisodesPayload && replayEpisodesPayload.episodes) || [];
  const sel =
    eps.find((e) => e.id === replayEpisodeSelected) ||
    eps.find((e) => e.id === defaultEpisodeId(eps)) ||
    null;
  const drawable = Boolean(sel && sel.points && sel.points.length);
  const key = drawable && companionIndicatorId ? `${sel.id}:${companionIndicatorId}` : null;
  const series = (key && companionSeriesCache.get(key)) || null;
  const needFetch = Boolean(key && !series && !(companionFetch && companionFetch.key === key));
  if (needFetch) companionFetch = { key, status: "loading" };
  const fetchNote =
    key && !series && companionFetch && companionFetch.key === key
      ? companionFetch.status === "loading"
        ? `<p class="erp-note">loading ${esc(companionIndicatorId)}…</p>`
        : `<p class="erp-empty">Could not load ${esc(companionIndicatorId)}: ${esc(companionFetch.message || "")}</p>`
      : "";
  setHTML(
    host,
    episodeChipsHtml(eps, sel && sel.id) +
      exposureReplayChartHtml(sel, series) +
      (drawable
        ? `<div id="erpCompanion">${companionPickerHtml(companionOptions(), companionIndicatorId)}${fetchNote}</div>`
        : ""),
  );
  if (drawable) {
    ensureStoredCompanionsProbed();
    loadServedFamilies(); // idempotent; repaints once with the served headings + rank
  }
  if (needFetch) fetchCompanionSeries(key, sel, companionIndicatorId);
}
function onEpisodeReplayChange(e) {
  const picker = e.target.closest("select.erp-ind-picker");
  if (!picker) return;
  companionIndicatorId = picker.value || null;
  companionFetch = null; // a fresh pick always retries a previously failed fetch
  renderEpisodeReplay();
}
function onEpisodeReplayClick(e) {
  const chip = e.target.closest("[data-episode]");
  if (!chip) return;
  replayEpisodeSelected = chip.dataset.episode;
  renderEpisodeReplay();
}
// Pointer-driven crosshair on the episode-replay price panel (the app.js onScrub idiom,
// re-derived for the erp frame): the builder embeds per-day {x, y, readout} + the frame
// in data-hover; this handler only maps pointer x → trading-day band and positions the
// layer. Parsed payload cached on the svg node (each re-render creates a fresh node).
function erpHideHover() {
  const host = document.getElementById("episodeReplay");
  if (!host) return;
  for (const layer of host.querySelectorAll(".hover-layer")) layer.setAttribute("visibility", "hidden");
}
/** Parse-and-cache one chart's data-hover payload on its (re-render-fresh) svg node. */
function erpHoverPayload(svg) {
  if (!svg.dataset.hover) return null;
  if (!svg.__erpHover) {
    try {
      svg.__erpHover = JSON.parse(svg.dataset.hover);
    } catch {
      return null;
    }
  }
  return svg.__erpHover;
}
/** Position ONE chart's hover layer at trading-day index i (both charts embed one
 *  entry per episode trading day, so the same i is valid on each). */
function erpPositionHover(svg, i) {
  const layer = svg.querySelector(".hover-layer");
  const hv = erpHoverPayload(svg);
  const d = hv && hv.days[i];
  if (!layer || !d) return;
  layer.querySelector(".xhair").setAttribute("x1", d.x);
  layer.querySelector(".xhair").setAttribute("x2", d.x);
  const dot = layer.querySelector(".hover-dot");
  if (d.y == null) {
    dot.setAttribute("visibility", "hidden");
  } else {
    dot.removeAttribute("visibility");
    dot.setAttribute("cx", d.x);
    dot.setAttribute("cy", d.y);
  }
  const text = layer.querySelector(".hover-read");
  text.textContent = d.r;
  const bg = layer.querySelector(".hover-read-bg");
  const box = text.getBBox();
  bg.setAttribute("x", box.x - 2);
  bg.setAttribute("y", box.y - 1);
  bg.setAttribute("width", box.width + 4);
  bg.setAttribute("height", box.height + 2);
  layer.setAttribute("visibility", "visible");
}
function onEpisodeReplayScrub(e) {
  const svg = e.target.closest("svg.erp-chart");
  if (!svg) return erpHideHover();
  const hv = erpHoverPayload(svg);
  const n = hv ? hv.days.length : 0;
  if (!n) return erpHideHover();
  // Letterbox-corrected client x → SVG user x (the scrubIndex idiom on the erp frame),
  // then band mapping: one x-step per trading day, floor not round (bands, not samples).
  const rect = svg.getBoundingClientRect();
  const drawnW = Math.min(rect.width, rect.height * (hv.w / hv.h));
  const xPad = (rect.width - drawnW) / 2;
  const userX = ((e.clientX - rect.left - xPad) / drawnW) * hv.w;
  const i = Math.max(0, Math.min(n - 1, Math.floor(((userX - hv.ml) / hv.pw) * n)));
  // The same day index positions every erp chart's layer (the companion overlay lives
  // ON the replay chart, so this loop normally sees one svg).
  const host = document.getElementById("episodeReplay");
  for (const s of host.querySelectorAll("svg.erp-chart")) erpPositionHover(s, i);
}
// Show one section-cluster, hide the other (the .is-hidden wrapper idiom). Families cluster
// = #lab bench + its overlay + the families-only mode/visibility bars; episodes cluster =
// #episodeReplay. Reflects the strip's aria-current and (on first episode open) fetches.
async function applySection(section, opts) {
  labSection = section === "episodes" ? "episodes" : "families";
  if (opts && opts.persist) {
    try {
      localStorage.setItem(SECTION_KEY, labSection);
    } catch {
      /* private-mode / quota — choice stays session-local, still applied below */
    }
  }
  const episodes = labSection === "episodes";
  for (const btn of document.querySelectorAll("#sectionStrip button")) {
    const on = btn.dataset.labSection === labSection;
    btn.setAttribute("aria-current", String(on));
    btn.setAttribute("aria-selected", String(on));
  }
  // Lab-only chrome (the bench, the loading/empty overlay, the #labToolbar row that wraps
  // the mode + visibility bars) hides wholesale in episode view so no dead control paints
  // beside the replay chart (the toolbar ROW disappears, leaving just tabs + links).
  for (const id of ["lab", "message", "labToolbar"]) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("is-hidden", episodes);
  }
  const host = document.getElementById("episodeReplay");
  if (host) host.classList.toggle("is-hidden", !episodes);
  if (episodes && host) {
    try {
      await ensureEpisodesLoaded();
      renderEpisodeReplay();
    } catch (err) {
      // ALLOWLISTED raw write: a self-contained plain-text error `<p>`, no `title=`, no producer.
      host.innerHTML = `<p class="erp-empty">Could not load episode replay: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  }
}
function onSectionStripClick(e) {
  const btn = e.target.closest("[data-lab-section]");
  if (!btn) return;
  applySection(btn.dataset.labSection, { persist: true });
}

// Delegated listeners: tile clicks/keys on the #lab container (survives the one
// skeleton build); mode switching on the always-present #modebar (outside #lab).
const lab = document.getElementById("lab");
lab.addEventListener("click", onClick);
lab.addEventListener("keydown", onKey);
document.getElementById("modebar").addEventListener("click", onModebarClick);
document.getElementById("visbar").addEventListener("click", onVisbarClick);
document.addEventListener("click", onReentryClick);
document.addEventListener("toggle", onReentryToggle, true);
document.getElementById("sectionStrip").addEventListener("click", onSectionStripClick);
document.getElementById("episodeReplay").addEventListener("click", onEpisodeReplayClick);
document.getElementById("episodeReplay").addEventListener("change", onEpisodeReplayChange);
document.getElementById("episodeReplay").addEventListener("pointermove", onEpisodeReplayScrub);
document.getElementById("episodeReplay").addEventListener("pointerleave", erpHideHover);
document.getElementById("episodeReplay").addEventListener("pointercancel", erpHideHover);
// Wire the shared #help-bar once: the capture-phase glyph handler stops a ⓘ tap
// from also cycling the tile (the delegated onClick above is a bubble listener).
// Families-board chip → Indicator detail: /lab has no Zone D, so the sheet's action row deep-links
// to the DASHBOARD (`/?ind=<id>#zone-d`, app.js intake). Never in Scenario (chips cycle there).
wireHelpBar(lab, document.getElementById("help-bar"), {
  detailAction: (host) => chipDetailTarget(host, { scenario: mode === "scenario" }),
  onDetail: (id) => {
    location.href = detailJumpUrl(id);
  },
});

// Landing view: a `?s=` deep-link seeds the scenario board (copyable/shareable board state,
// incl. R4 phases); otherwise Live (latest cron snapshot). For a new user (no stored map) only the
// floors strip, Families board and Danger ledger show — see VIS_DEFAULTS.
const initS = new URLSearchParams(location.search).get("s");
if (initS) {
  scenario = parseScenarioQuery(initS);
  methodDrivesBoard = false; // a hand-set deep-link, not a method-card firing ⇒ breaker computed
  setMode("scenario");
} else {
  setMode("live");
}
// Apply the persisted section choice AFTER the mode kickoff (Families default). If the user
// last left on Episode replay, this hides the families chrome and fetches /api/replay; the
// live/scenario fetch above still runs into the hidden bench, harmlessly.
applySection(labSection);
