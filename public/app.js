/*
 * crash-dash dashboard — Zones A/B/C/D over the read API.
 *
 * Data-down flow: fetchAll() pulls the read endpoints, normalizes them into one
 * `state` object, and hands it to render(state). render() is the only caller of
 * the per-zone render helpers; the helpers are pure (state -> HTML string) and
 * never reach back into the network. One place (STATE_COLORS / ALERT_COLORS)
 * maps a state/level to a color — no hex literals elsewhere.
 *
 * Charts are inline SVG, all in Zone D — detail + bubble tier via ./detail-chart.js, the alert ladder via ./ladder-chart.js,
 * all three returning the same `{ svg, detail }` so ONE crosshair/hover seam serves every tab. Series data is fetched lazily and cached.
 *
 * NOT vitest-importable: top-level DOM (els registry, addEventListeners,
 * fetchAll() at boot) + zero exports. To unit-test or single-source any logic
 * here, extract the pure part into a DOM-free sibling and import it back — the
 * established pattern (ladder-chart.js / haven-envelope.js);
 * characterization-test the sibling, not app.js. The DOM
 * render itself is covered only by the Playwright e2e (npm run preview:shot).
 */

import { createState, guardToken, isCurrent } from "./app-state.js";
import { writeBoot } from "./refetch-gate.js";
import { loadDashboard } from "./load-cycle.js";
import { HELP_GLYPH_CLASS } from "./help-decorate.js";
import { deepLinkIndicatorId } from "./detail-jump.js";
import { decorateHelp, setHTML, wireHelpBar } from "./help-bar.js";
import { INDICATOR_DESC } from "./indicator-desc.js";
import { idIfDistinct } from "./leading-name.js";
import { topIndicatorsFor, DEFAULT_LEG } from "./leg-top.js";
import { readLegChartPos, writeLegChartPos } from "./leg-chart.js";
import { velocityChipLabel, velocityTip } from "./velocity-span.js";
import {
  ALERT_COLORS,
  STATE_LETTER,
  formatValue,
  esc,
  STACK_CH,
} from "./chart-primitives.js";
import { detailChart, splitLegend } from "./detail-chart.js";
import { wireHoverReadout } from "./hover-readout.js";
import { wireFitToggle } from "./fit-toggle.js";
import { renderDetailTab as renderDetailTabImpl, fetchDetailSeries, chipWindow, readDetailWindow, writeDetailWindow } from "./detail-tab.js";
import { ladderChart } from "./ladder-chart.js";
import { formatDelta, latestValue, windowReturnPct } from "./format.js";
import { sortByFamilyOrder } from "./family-order.js";
import { cardLagMark, familyLagCountMark, feedsBehindPill, intradayMark, intradayVerdictChip, lastPrintMark } from "./feed-age-mark.js";
import { bottomPanelHTML, slowPanelHTML } from "./off-ladder-panel.js";
import { BOTTOM_META, SLOW_BAND_META } from "./off-ladder-specs.js";
import { apiFetch, canViewPage, loadSession } from "./auth-session.js";
import { dropPrefetches, fetchOnce, fetchOnceVia, prefetchThenGate } from "./gate-prefetch.js";
import { API_TIMEOUT_MS, getJson, request } from "./http.js";
import { deadLitIds, DEAD_NOTE } from "./tile-members.js";

// The first load cycle's public reads start before the gate (taken by `fetchOnce`), off the renewal path. /status
// is prefetched only on a LIVE session: an expired one renews in the gate first, so no take runs ahead of the renewal.
const BOOT_URLS = [...(loadSession() ? ["status"] : []), "indicators", "history?limit=2", "config", "families"].map((p) => `/api/${p}`);
// P11-gate — before any localStorage paint: `canViewPage` says no ⇒ /overview.
if (!(await prefetchThenGate(BOOT_URLS, canViewPage, apiFetch))) {
  location.replace("/overview");
  await new Promise(() => {}); // hold the module while the navigation lands
}

const API = "/api"; // same-origin serverless read functions

// --- Color is state, everywhere. Single source: STATE_COLORS / STATE_LETTER /
// ALERT_COLORS all live in chart-primitives.js (the ladder chart reads the alert ramp
// too, so it can't stay local here). -----------------------------------------
// The state ramp as CLASSES, for MARKUP (`.state-dot.g|a|r`, styles.css). The COLOUR tables may
// reach only CSSOM or an SVG attribute — a markup style attribute is dropped in prod
// (`.claude/rules/frontend.md` §Inline style attributes are dead in prod). STATE_DOT_CLASS mirrors
// the `STATE_CLASS` idiom already used by lab.js / band-panel.js.
const STATE_DOT_CLASS = { GREEN: "g", AMBER: "a", RED: "r" };

// --- Legend: single source of fly-over (title=) help text. -------------------
// Every section header and box carries a native-title tooltip explaining what it
// is and what its numbers mean.
const LEGEND = {
  alertLevel:
    "Overall alert level - the band the T1 danger dial's regime maps to (upgrades apply immediately; a lower band must hold 2 runs to de-escalate). OK → WATCH → WARNING → CRITICAL; pushed to ntfy when it changes.",
  verdictTitle: "How dangerous the market looks right now, scored from the indicator set. Drives the alert band. Notify-only.",
  // Neither pill is FRED-specific: the same freshness read covers the ECB (EURC), price-feed
  // and index-EOD ids. Say "observation", not "FRED observation" —
  // this legend hosts BOTH the zone-A heartbeat pill and the per-card feed-lag help.
  feedFresh: "Data feed is current - newest observation is within tolerance.",
  feedLag: "Data feed is lagging - (Nd) = days since the newest observation.",
  // The SECOND pill, and deliberately a different measurement from the two above — keep BOTH.
  // feedFresh/feedLag read ONE number — the newest observation across all
  // feeds — so a single current feed keeps them green. This one counts feeds individually.
  feedsBehind:
    "Per-feed count - how many of the individual data feeds are behind THEIR OWN publication cut, out of the whole roster. The pill beside it is a single heartbeat instead: the newest observation across ALL feeds together, so one current feed keeps it fresh while many others sit behind. The two can therefore disagree - that is why both are shown. Count only: this page does not grade how far behind a feed is, the /lab board does.",
  transition: "Alert level changed between the two most recent daily runs.",
  indicators:
    "Individual indicators grouped by family. Each card shows the latest value, its Δ change and confirmed Green/Amber/Red state. Tap or click a card for its history.",
  // The per-card Δ chip and its tooltip are NOT legend constants: both halves of that copy (the
  // span and the observation-grid word) are per-id, so they compose in `velocity-span.js` off the
  // card's own meta.
  tabLadder:
    "Overall alert level plotted over time; ringed dots mark runs that pushed a notification. Hover or drag across the chart for the per-run readout.",
  tabDetail: "One indicator's value over time against its amber/red threshold bands.",
  tabBubble:
    "Slow bubble-state inputs over time - the price-acceleration percentile and the two complacency legs (VIX percentile, distance to 252d high), drawn with the same chart as Indicator detail: value line, confirmed-state ribbon, threshold cuts dashed, and one linked crosshair readout across all three.",
  range: "Show the last N days of history (all = full record).",
  bottom:
    "VIX bottom signal - a contrarian, off-ladder read of the SAME instrument the crash-risk verdict watches, in the OPPOSITE direction: an extreme, peaking-and-receding VIX hints fear may be exhausting. CAPITULATION-WATCH = acute panic now (a heads-up, NOT a buy); BOTTOM-FORMING = the spike has crested AND the VIX/VIX3M term structure is easing back toward contango. Always 'downside risk remains', never 'buy'. Fully isolated - it does not relax the OK/WATCH/WARNING/CRITICAL verdict.",
  slow:
    "Bubble-state signal - a slow, off-ladder gauge of how much speculative 'fuel' has built up, NOT a crash call. It rolls price acceleration (QQQ 63-day return percentile) and complacency (VIX in its low decile + price near its 252-day high) into CALM / ELEVATED-BUBBLE-STATE / DE-RISK. Higher = more froth, a heads-up to consider trimming risk - never a timing trigger. Fully isolated: it does not move the OK/WATCH/WARNING/CRITICAL verdict.",
};

const SLOW_POINTS = 30; // recent points pulled per bubble-state leg (renderZoneSlow)

// --- Single mutable-state container (D12) ------------------------------------
// ALL app.js mutable state lives in `state`; every mutation funnels through
// `setState` (except in-place Map mutations on `state.seriesCache`, which stay
// Map mutations). No scheduling — render calls stay explicit at today's call
// sites. Container + guard helpers live in ./app-state.js (tested sibling).
const { state, setState } = createState({
  // Per-indicator /series cache. Series move once a day (the cron's cadence), so
  // one fetch per indicator per page session is plenty — the live value/state in
  // each card still refreshes from /status every poll. `null` = a fetch failed
  // (draw the flat-dash fallback and don't retry-storm on every render).
  seriesCache: new Map(),
  familyOrder: [], // served family list — see getFamilies()
  ladderConfig: null, // /api/config — see getConfig()
  memberWeight: null, // /api/danger-model `memberWeight` — see getMemberWeight()
  deadLitIds: null, // weighted ids no pillar folds (tile-members.js deadLitIds) — same fetch
  // Persisted Zone D selection (survives polls + re-renders).
  zoneD: { tab: "detail", ladderLimit: 90, window: readDetailWindow(safeStorage()), indicatorId: null, legId: DEFAULT_LEG, legChartPos: readLegChartPos(safeStorage()), compareIds: [null, null], details: null },
  lastView: null, // newest normalized view, so Zone D interactions can redraw
  // The painted vintage `{firedAt, deployId}` (refetch-gate.js, P9): null until the first paint.
  vintage: null,
});

/**
 * The `?mult=<m>` display-only what-if multiplier, read ONCE from the URL and
 * constant for the page's lifetime. Purely a display
 * overlay: it moves the detail chart's band lines + state ribbon, never the cards, the alert
 * badge, or the off-ladder panels — those come from /api/status, baked at cron time.
 *
 * Parsed permissively, then SNAPPED to the server's 0.5..2.0 step-0.25 grid (P12.b): the server
 * now 400s any off-grid value instead of clamping (a clamp minted an unbounded edge-cache key
 * space), so the client must only ever emit grid values. A hand-typed `?mult=0.6` becomes 0.5,
 * and the badge reads the snapped value actually applied. Non-numeric / absent / ≤0 ⇒ OFF, the
 * fail-safe direction: an OFF page renders identically to today and shows no badge.
 */
const MULT = (() => {
  const raw = new URLSearchParams(location.search).get("mult");
  const m = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(m) || m <= 0) return 0;
  // Snap to the served grid — round to the nearest quarter, then clamp into [0.5, 2.0].
  return Math.min(2, Math.max(0.5, Math.round(m * 4) / 4));
})();


/**
 * Fetch + cache an indicator's series (newest-last). Returns null on failure.
 * `detail=true` (the detail chart only) sends `?detail=1`, opting into the on-read
 * recompute so the state ribbon re-tunes with its band lines; it's keyed separately
 * (`id:limit:detail`) so the plain cache (`id:limit`) stays unfragmented,
 * and the server ignores the flag for indicators whose ribbon is mode-invariant
 * (derived/proxy/bands-less).
 */
async function getSeries(id, limit, detail = false, from = null) {
  // `mult`/`from` join the cache key ONLY when set, so an OFF/count-window page keys
  // byte-identically to before (`id:limit[:detail]`); MULT is constant for the page's
  // lifetime, but keying it disarms the on/off-collision trap a future live toggle would spring.
  const detailKey = detail ? `${id}:${limit}:detail` : `${id}:${limit}`;
  const fromKey = from ? `${detailKey}:from${from}` : detailKey;
  const key = MULT > 0 ? `${fromKey}:m${MULT}` : fromKey;
  if (state.seriesCache.has(key)) return state.seriesCache.get(key);
  const detailQ = detail ? "&detail=1" : "";
  // Date-anchored window (open-ended `to`): the server slices to obs_date ≥ from at the wire
  // edge across every branch, so the payload is bounded by the window regardless of `limit`.
  const fromQ = from ? `&from=${encodeURIComponent(from)}` : "";
  // Inert on the non-detail fetches (no detail ⇒ no recompute branch ⇒ server won't shift or
  // echo), so forwarding it unconditionally is safe and keeps one fetch path.
  const multQ = MULT > 0 ? `&mult=${encodeURIComponent(MULT)}` : "";
  try {
    const res = await request(`${API}/series?id=${encodeURIComponent(id)}&limit=${limit}${detailQ}${fromQ}${multQ}`, { fetchImpl: apiFetch, timeoutMs: API_TIMEOUT_MS });
    const data = res.ok ? await res.json() : null;
    state.seriesCache.set(key, data);
    return data;
  } catch {
    state.seriesCache.set(key, null);
    return null;
  }
}

// Family grouping for the Zone C indicator cards (a UI concern, not ladder math).
// The ordered family list {key,label,desc} is SERVED by /api/families (backed by
// DASHBOARD_FAMILIES in src/families.ts — the single source of truth), so the
// browser re-declares nothing; renderZoneC groups /api/indicators metas by their
// server-attached `family` key. Static per deploy → fetch once and cache like
// getConfig. `[]` until the first successful fetch (state.familyOrder).
async function getFamilies() {
  if (state.familyOrder.length) return state.familyOrder;
  try {
    const res = await request(`${API}/families`, { fetchImpl: fetchOnce, timeoutMs: API_TIMEOUT_MS });
    if (!res.ok) return state.familyOrder;
    setState({ familyOrder: await res.json() });
    return state.familyOrder;
  } catch {
    return state.familyOrder;
  }
}

// ⚠ `/api/families` serves the whole render rank itself (meta-views.ts familiesView:
// each family's ranked members + its overlay ids, then a SYNTHETIC entry per non-family card zone),
// so both consumers — renderZoneC's group order and renderDetailTab's picker — read the served
// list and the browser re-declares nothing. Never re-introduce a roster copy here.

// Ladder config (alertRank/scoringCuts) from /api/config.
// Static — moves only on deploy — so fetch once and cache for the page session.
// `null` until the first successful fetch (state.ladderConfig); Zones B + D's
// ladder degrade until then.
async function getConfig() {
  if (state.ladderConfig) return state.ladderConfig;
  try {
    const res = await request(`${API}/config`, { fetchImpl: fetchOnce, timeoutMs: API_TIMEOUT_MS });
    if (!res.ok) return null;
    setState({ ladderConfig: await res.json() });
    return state.ladderConfig;
  } catch {
    return null;
  }
}

// Per-member ladder magnitudes (`memberWeight`) from /api/danger-model — the danger engine's own
// MEMBER_WEIGHT table, served raw. The detail explainer derives its "where it lands on the ladder"
// line from it rather than carrying a hand-typed leg roster (see leg-impact.js). Static per deploy
// ⇒ fetch once and cache like getConfig; `null` until the first success, and the explainer simply
// omits the line while it is cold or if the fetch fails. The same body seeds `deadLitIds` (Zone C's ⌁ note).
async function getMemberWeight() {
  if (state.memberWeight) return state.memberWeight;
  try {
    const body = await getJson(`${API}/danger-model`, { timeoutMs: API_TIMEOUT_MS });
    setState({ memberWeight: body?.memberWeight ?? null, deadLitIds: deadLitIds(body) });
    return state.memberWeight;
  } catch {
    return null;
  }
}

// Adding a dashboard zone = THREE places: this registry, its render() call site,
// AND both showLoading()'s hide list and render()'s un-hide list — miss the last
// pair and the empty section shows a bordered gap during the first-load skeleton.
const els = {
  message: document.getElementById("message"),
  banner: document.getElementById("banner"),
  dashboard: document.getElementById("dashboard"),
  zoneA: document.getElementById("zone-a"),
  zoneBottom: document.getElementById("zone-bottom"),
  zoneSlow: document.getElementById("zone-slow"),
  zoneC: document.getElementById("zone-c"),
  zoneD: document.getElementById("zone-d"),
  helpBar: document.getElementById("help-bar"),
  // Outside #dashboard on purpose: Zone D's innerHTML is replaced every poll, and this bar must
  // survive it (and stay position:fixed) — see index.html.
  hoverBar: document.getElementById("hover-bar"),
};

// --- Small formatting helpers ----------------------------------------------

// `esc`, `formatValue`, `formatDerived` (+ CURRENCY_UNITS) live in chart-primitives.js;
// `formatDelta`, `pensionPct`, `slowMetricVal`, `latestValue`, `whatIfBadge` live in format.js.

// --- Page-state switches (loading / empty / error / rendered) ---------------

/** Recolor the tab favicon to the alert level — reuses the CSS alert ramp so the
 *  color stays single-sourced (no hex duplicated in JS). */
function setFavicon(level) {
  const css = getComputedStyle(document.documentElement);
  const color = css.getPropertyValue(`--alert-${level.toLowerCase()}`).trim() || "#5f7a5f";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${color}'/></svg>`;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.setAttribute("href", "data:image/svg+xml," + encodeURIComponent(svg));
}

/** First paint: skeleton banner + shimmer cards instead of a bare "Loading…". */
function showLoading() {
  els.message.hidden = true;
  els.banner.hidden = true;
  els.dashboard.hidden = false;
  els.zoneBottom.hidden = true; // no skeleton — hide until data (like the bars/charts)
  els.zoneSlow.hidden = true; // ditto — the off-ladder panels just hide until data
  els.zoneD.hidden = true;
  setHTML(
    els.zoneA,
    `
    <div class="skel-banner">
      <div class="skel skel-chip-lg"></div>
      <div class="skel-lines"><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>
    </div>`,
  );
  setHTML(els.zoneC, `<div class="card-grid">${'<div class="skel skel-card"></div>'.repeat(6)}</div>`);
}

function showEmpty() {
  els.message.textContent = "No runs recorded yet - the gauge runs once each weekday.";
  els.message.hidden = false;
  els.dashboard.hidden = true;
  els.banner.hidden = true;
}

function showError() {
  // Non-destructive: keep whatever's already on screen, just flag the failure.
  // There is no timer — the only automatic refetch is the `visibilitychange`
  // listener at the foot of this file (plus a manual reload), so the copy must
  // not promise a countdown.
  els.banner.textContent =
    "Couldn't load - showing the last data. Retries when you switch back to this tab, or reload the page.";
  els.banner.hidden = false;
}

// --- Zone A: verdict banner -------------------------------------------------

function renderZoneA({
  verdict,
  asOf,
  provisional,
  lag,
  feedAgeDays,
  feedsLagging,
  laggingFeedIds,
  feedsTotal,
  history,
  indicators,
}) {
  const accent = ALERT_COLORS[verdict.level];
  document.documentElement.style.setProperty("--accent", accent);
  document.title = `● ${verdict.level} - crash-dash`;
  setFavicon(verdict.level); // recolor the tab dot so a backgrounded tab signals

  const heartbeat = lag
    ? `<span class="pill pill-lag" title="${esc(LEGEND.feedLag)}">feed lag (${feedAgeDays}d)</span>`
    : `<span class="pill pill-fresh" title="${esc(LEGEND.feedFresh)}">feed fresh ✓</span>`;

  // The per-feed pill rides BESIDE the heartbeat, never replacing it — the
  // markup is pre-escaped by the seam. Absent wire fields (an old cached payload) render nothing.
  // Rule 2's spirit (`public/prose-names.test.ts` — that guard scans element TEXT, so it does not
  // reach this `title=`): the tooltip names registry ids, so they ride with their served
  // label. `/api/indicators` maps ALL_INDICATORS unfiltered, but `freshnessFrom`'s roster
  // ALSO covers the composite components (`CMP_*` etc.) that never reach `indicators` — those keep
  // their bare id via `idIfDistinct`'s missing-label path, which is the intended degrade.
  const feedLabels = Object.fromEntries((indicators || []).map((i) => [i.id, i.label]));
  const perFeed =
    feedsBehindPill({ feedsLagging, laggingFeedIds, feedsTotal }, LEGEND.feedsBehind, feedLabels)?.html ??
    "";

  // Transition line from the two newest /history rows (newest first). Hide it
  // unless the level actually changed between the last two recorded runs — and on an INTRADAY verdict:
  // /history is alert_log (EOD) only, so its X → Y would contradict the head's daytime level.
  let transition = "";
  if (!provisional && history.length >= 2 && history[0].level !== history[1].level) {
    transition = `<span class="transition" title="${esc(LEGEND.transition)}">${esc(history[1].level)} → ${esc(history[0].level)}</span>`;
  }

  return `
    <div class="verdict-head">
      <div class="alert-chip" title="${esc(LEGEND.alertLevel)}" aria-label="alert level: ${esc(verdict.level)}">${esc(verdict.level)}</div>
      <div class="verdict-meta">
        <span class="verdict-title" title="${esc(LEGEND.verdictTitle)}">Market danger level</span>
        <span class="verdict-subline">
          <span title="Date of the FRED observations this run scored.">as-of ${esc(asOf)}</span>${intradayVerdictChip({ provisional, asOf })}${heartbeat}${perFeed}${transition}
        </span>
      </div>
    </div>
  `;
}

// --- Bottom-signal panel (contrarian off-ladder VIX capitulation read) ------
// META constants → off-ladder-specs.js; the renderZoneBottom shell
// (els.* + setHTML) stays here.

// --- The one card primitive -------------------------------------------------
// Every `.card` on the page comes from here — zone-C's risk indicators (the
// off-ladder panels draw no cards). Callers map their own
// data onto a CardSpec; this function owns the markup and NOTHING else.
//
//   CardSpec = { id, label, value, dot, tip?, ariaLabel, delta?, marker?, lagHtml? }
//   Dot      = { color, letter, label } | null   (null → neutral dim dot)
//   Delta    = { text, tip? } | null             (inline, on the .card-value line)
//   Marker   = { kind, tip } | null              (one head marker; see below)
//
// EVERY card is clickable — `data-id` + role=button + tabindex — and opens that id in
// Zone D's detail tab via the one delegated handler on #dashboard. Leg ids resolve
// there just like indicator ids: /api/indicators maps ALL_INDICATORS unfiltered, so
// the pension / VIX-bottom / bubble legs are already in lastView.indicators (zone C
// merely filters them out of its own grid).
//
// The dot tone is a PARAMETER, never resolved here — the caller passes `dot.cls`, a class
// token. That is load-bearing: a palette OFF the --state-* alarm ramp (pension's orange,
// VIX-bottom's contrarian teal) must be able to opt out of the shared scale, and it does so by
// passing its own class. A CLASS and not a colour: a colour could only be painted through a style
// attribute, which prod drops (`.claude/rules/frontend.md` §Inline style attributes are dead in prod).
//
// The bubble is NEVER colour-only: it carries dot.letter + an aria-label from
// dot.label. A null dot draws the neutral dim dot ("no reading yet").
//
// Δ20 rides INLINE on the .card-value line and the card's notes collapse to a single
// head marker, so every card is head + value — one height, no .card-foot.
//
// The marker renders as nothing but its injected ⓘ: it is a `[title]` host, so
// decorateHelp appends the glyph and the capture-phase click handler both opens the
// help bar and stopPropagation()s, which is what keeps a marker tap from activating
// its clickable card. It must therefore NEVER be added to HELP_CARVEOUT_SELECTOR —
// the carve-out branch deliberately does not stop propagation.
function cardMarkup(spec) {
  const dot = spec.dot
    ? `<span class="state-dot ${esc(spec.dot.cls)}" aria-label="${esc(spec.dot.label)}">${esc(spec.dot.letter)}</span>`
    : `<span class="state-dot unknown" aria-label="state: unknown">-</span>`;

  const delta = spec.delta
    ? `<span class="card-delta"${spec.delta.tip ? ` title="${esc(spec.delta.tip)}"` : ""}>${esc(spec.delta.text)}</span>`
    : "";

  const marker = spec.marker
    ? `<span class="card-marker card-marker--${esc(spec.marker.kind)}" title="${esc(spec.marker.tip)}"></span>`
    : "";

  // Feed-lag mark: PRE-ESCAPED markup from the `feed-age-mark.js` seam (`cardLagMark`), so the
  // string and its copy are unit-testable without a DOM. "" on a fresh feed — an empty slot, never
  // a `⌁ 0d`. It is a plain `[title]` host like `.card-marker`, so decorateHelp gives it the same
  // ⓘ affordance on touch; it must NEVER join HELP_CARVEOUT_SELECTOR for the same reason.
  const lagHtml = spec.lagHtml ?? "";

  const cls = "card";

  // The card head shows the id as a scanning key AFTER the label (`Bund 10y−2y BUND`), so keep it only when
  // it adds information (`HY OAS F1`); a restating id (`OVX`/`OVX`) drops to the label alone so the
  // head does not stutter the same token twice. `data-id` keeps the raw id.
  const cardId = idIfDistinct(spec.label, spec.id);

  // spec.tip rides the card NAME, not the whole <article> (mirrors /lab's .tile→.t-h): a whole-card
  // title would make every card tap open help under HELP_TAP_PRIORITY_SELECTOR and steal
  // onCardActivate; the label is the help surface, the rest of the card body still activates the detail tab.
  return `
    <article class="${cls}" data-id="${esc(spec.id)}" role="button" tabindex="0" aria-label="${esc(spec.ariaLabel)}">
      <div class="card-head">
        <span class="card-name"><span class="card-label"${spec.tip ? ` title="${esc(spec.tip)}"` : ""}>${esc(spec.label)}</span>${
          cardId ? `<span class="card-id">${esc(cardId)}</span>` : ""
        }</span>
        ${lagHtml}
        ${marker}
        ${dot}
      </div>
      <div class="card-value">${esc(spec.value)}${delta}</div>
    </article>
  `;
}

// --- Off-ladder panels: verdict banners, no cards ---------------------------
// Every leg these three panels cover renders as a Zone-C family card with its own
// confirmed state and value — a panel card strip would be pure duplication.
// What is NOT duplicated — each panel's off-ladder verdict: band, headline number
// and copy — lives here, above the fold.

// Sync (state + values both ride on /status): the banner carries the panel verdict
// (state label + frame + sub). The VIX / VIX3M legs live in Zone C's "Volatility"
// family group.
function renderZoneBottom({ verdict }) {
  const state = verdict.bottomState ?? null;
  const meta = BOTTOM_META[state];

  // Muted (CALM / null-degraded) vs active branch + byte-identical markup live in
  // the pure builder; this shell owns els.* + setHTML.
  setHTML(els.zoneBottom, bottomPanelHTML(verdict, { legend: LEGEND.bottom, meta }));
}

// --- Bubble-state panel (slow off-ladder bubble-fuel read) ------------------
// SLOW_BAND_META → off-ladder-specs.js; renderZoneSlow's async /series
// pull + stale-render guard + setHTML stay here.

// STAYS async: the band/score ride on /status (verdict.slowBand/slowScore),
// but the continuous per-leg metrics — the informative half of this read — come from
// /series per leg, so this fills els.zoneSlow itself rather than returning a string.
async function renderZoneSlow(view) {
  const { verdict } = view;
  const band = verdict.slowBand ?? null;
  const meta = SLOW_BAND_META[band];

  // Pull each observability leg's series BEFORE the band branch, so the metrics
  // print in BOTH the muted (CALM / degraded) and active states — the track stays
  // readable in the common quiet state, exactly as the always-on leg cards were.
  const token = guardToken(state, ["lastView"]); // === `view` here (called sync from render)
  const [accel, cvix, chigh] = await Promise.all([
    getSeries("price-accel", SLOW_POINTS),
    getSeries("complacency-vix", SLOW_POINTS),
    getSeries("complacency-high", SLOW_POINTS),
  ]);
  // Stale-render guard: a newer poll may have replaced `lastView` while we
  // awaited. Identity check (this call's immutable `view` snapshot vs the mutable
  // container) — both branches paint now, so only the latest render clobbers the DOM.
  if (!isCurrent(state, token)) return;

  const metrics = { accelM: latestValue(accel), cvixM: latestValue(cvix), chighM: latestValue(chigh) };
  const score = verdict.slowScore;
  // OFF-2 — the denominator comes from the SAME persisted run as the score. Never derived here:
  // the FE cannot see how many slow components were scored (the /series legs are the split
  // observability set, one more than the scored set).
  const maxScore = verdict.slowMaxScore ?? null;

  // Muted-vs-active branch, the slow-score + metrics footer lines and the
  // byte-identical markup live in the pure builder; this shell owns els.* + setHTML
  // (the async /series pull + the lastView stale-render guard above stay here).
  setHTML(els.zoneSlow, slowPanelHTML({ band, score, maxScore, metrics }, { legend: LEGEND.slow, meta }));
}

// --- Zone C: indicator grid -------------------------------------------------

// Cards that are scored together are bracketed into one labelled group within
// their channel so the coupling is obvious without opening the detail chart.
// F4's Red gate fires only when NVDA is ALSO below its own MA200, so the two are
// rendered side by side inside a "Combined" box (see ALL_INDICATORS order, which
// keeps them adjacent). `ids` are in display order; the group renders only the
// members actually present in the channel.
const COMBO_GROUPS = [
  {
    ids: ["F4", "NVDA"],
    label: "Combined → semis Red gate",
    tip: "F4 goes Red only when SMH is ≥25% down over ~6 months AND NVDA is below its own MA200 - the two are scored together.",
  },
];

// VT (VIX term-structure) relabels its generic G/A/R dot with term-structure vocabulary
// (frontend only — scoreVixTermIndicator's GREEN/AMBER/RED off the VT ratio cuts served in
// cfg.scoringCuts.vt (src/confirmers.ts) is unchanged; this is a display relabel, not a
// numeric mirror): GREEN=contango (calm), AMBER=flat, RED=backwardation. The colour still rides
// the state ramp (contango green → backwardation red); only the letter + aria-label change.
const VT_DOT = {
  GREEN: { letter: "C", label: "contango" },
  AMBER: { letter: "F", label: "flat" },
  RED: { letter: "B", label: "backwardation" },
};

/** One Zone-C indicator card. */
function renderCard(meta, reading) {
  const unit = meta.unit; // '%', '', '€' or '$' — the API materializes the "%" default, so never undefined
  // ETFs cards paint the served 20d window return (null in the served body, R7a ⇒ "-"), never the level.
  const windowReturn = meta.family === "pension-drawdown" ? (reading?.return20d ?? null) : undefined;
  const value =
    windowReturn !== undefined ? windowReturnPct(windowReturn) : reading ? formatValue(reading.value, unit) : "-";

  // State dot: letter + aria-label, never color-only. No reading -> neutral. VT
  // relabels its G/A/R with term-structure vocabulary (VT_DOT — contango/flat/
  // backwardation); every other card uses the generic STATE_LETTER, and both ride
  // the same colour ramp. Resolved HERE, not in cardMarkup — the primitive takes the
  // dot as a parameter so the off-ladder palettes stay off the --state-* ramp.
  // No title= on purpose: the confirmed-state help is identical across every dot,
  // so a per-dot fly-over (and its mobile ⓘ glyph) is pure redundant noise.
  // A VALUE-ONLY reading (the F7/CAPE context card, /api/status `valueOnly`) carries a live value
  // but no meaningful RAG state — suppress the colour dot (render the neutral "—" dim dot) so a
  // placeholder GREEN never reads as a real calm signal. State stays strict G/A/R on the wire.
  const dot =
    reading && !reading.valueOnly
      ? {
          cls: STATE_DOT_CLASS[reading.state],
          letter: meta.id === "VT" ? VT_DOT[reading.state].letter : STATE_LETTER[reading.state],
          label: meta.id === "VT" ? `term structure: ${VT_DOT[reading.state].label}` : `state: ${reading.state}`,
        }
      : null;

  // The Δ chip and its tooltip BOTH resolve from the id's own `velocityWindow` and its
  // OBSERVATION grid (`obsCadence ?? cadence`) — never a literal "20" and never `cadence` alone.
  // `velocity-span.js` owns the composition and the reasoning; the chip label it returns is the
  // same string the detail chart's primary axis carries, pinned in `velocity-span.test.js`.
  const deltaTip = velocityTip(meta);
  // Value-only cards (F7/CAPE) carry no scored Δ — drop the delta line entirely rather than
  // print a fake "Δ 0.00" (cardMarkup renders nothing for a null delta).
  const delta = reading
    ? windowReturn != null
      ? { text: "20d", tip: "return over the last 20 stored closes (live while the market is open)" }
      : reading.valueOnly
      ? null
      : { text: `${velocityChipLabel(meta)} ${formatDelta(reading.delta20, unit, meta.velocityMode)}`, tip: deltaTip }
    : { text: "no reading yet" };

  // Tooltip leads with the name — the label, then the id only when it adds information
  // (`idIfDistinct`): `HY OAS F1 — …`, but `OVX — …` where the id restates the
  // label. Then the explainer's "what it measures" line (the card face already
  // carries value, Δ20 and the state dot, so live state here would be redundant). Falls back to the
  // "<channel> channel" clause when an indicator has no INDICATOR_DESC entry/tip — the name prefix
  // is OUTSIDE the ??, so both branches render the same "<name> — …" shape.
  const desc = INDICATOR_DESC[meta.id];
  const name = [meta.label, idIfDistinct(meta.label, meta.id)].filter(Boolean).join(" ");
  const cardTip = `${name} - ${desc?.tip ?? `${meta.channel} channel`} Tap or click for history.`;

  // A card's notes collapse into ONE .card-head marker whose title carries every
  // note in full — reachable on hover AND (via the injected ⓘ) on touch. The
  // marker takes its colour from the FIRST note, so the ordering here is a priority:
  // pending (transient, act on it) before context (permanent property).
  const notes = [];
  // raw flipped without confirming on the close this reading was scored. Every indicator confirms
  // same-day, so a FRESH reading can never diverge — this only fires on a stored legacy row. Skip for
  // value-only cards: they assert no state anywhere, so a placeholder rawState/state must never badge.
  if (reading && !reading.valueOnly && reading.rawState !== reading.state) {
    notes.push({ kind: "pending", text: "pending", tip: "raw state flipped without confirming on that close" });
  }
  // CHART-ONLY ids (`CHART_ONLY_INDICATORS`, registry.ts — VTP today) are persisted and charted
  // but sit in NO scored set, NO family, NO roll-up and off the push; `meta.chartOnly` is the wire
  // flag (/api/indicators). It SUPERSEDES the CONTEXT note below — it says everything that note
  // says and more — so the two are exclusive rather than stacked on one marker.
  if (meta.chartOnly) {
    notes.push({
      kind: "context",
      text: "chart only - not scored",
      tip: "history is charted for context only: no family, no weight, no alert, no push",
    });
  } else if (meta.channel === "CONTEXT") {
    // CONTEXT indicators are surfaced but never fire — don't read an amber as an alert.
    notes.push({
      kind: "context",
      text: "context - never fires",
      tip: "excluded from the alert roll-up",
    });
  }
  if (state.deadLitIds?.has(meta.id)) notes.push(DEAD_NOTE);

  return cardMarkup({
    id: meta.id,
    label: meta.label,
    value,
    dot,
    tip: cardTip,
    ariaLabel: name,
    delta,
    marker: notes.length ? { kind: notes[0].kind, tip: notes.map((n) => `${n.text} - ${n.tip}`).join(" · ") } : null,
    // Feed-lag age mark (`feed-age-mark.js`) — off `reading.lag` + `reading.ageDays`, both already
    // on /api/status. ONE tier: it says "behind"/"lag" and never "deep lag", which /api/status
    // does not measure. `null` (fresh, or no reading) paints an empty slot, never a `⌁ 0d`.
    // B7: an INTRADAY-overlaid reading (`provisional`) prefixes its label; the dot already reads its state.
    // E22: a served `lastPrint` (held between releases, or a daily id behind its market day) takes the age mark's slot.
    lagHtml: intradayMark(reading, reading?.date) + (lastPrintMark(reading)?.html ?? cardLagMark(reading)?.html ?? ""),
  });
}

/**
 * Render a channel's cards in /indicators order, bracketing any COMBO_GROUPS
 * members into a single labelled box. Combo members are emitted once, at the
 * position of their first member; non-combo cards render normally.
 */
function renderChannelCards(metas, readingsById) {
  const done = new Set();
  const out = [];
  for (const meta of metas) {
    if (done.has(meta.id)) continue;
    const group = COMBO_GROUPS.find((g) => g.ids.includes(meta.id));
    if (!group) {
      out.push(renderCard(meta, readingsById.get(meta.id)));
      continue;
    }
    const members = group.ids.map((id) => metas.find((m) => m.id === id)).filter(Boolean);
    members.forEach((m) => done.add(m.id));
    const cards = members.map((m) => renderCard(m, readingsById.get(m.id))).filter(Boolean);
    // Degenerate: 0 or 1 present member → no 2-column bracket around a lone/absent card.
    if (cards.length < 2) {
      if (cards.length === 1) out.push(cards[0]);
      continue;
    }
    // aria-label names the group for AT; the visible .combo-label is aria-hidden
    // so screen readers don't announce the same text twice. tip stays on the label
    // as a sighted-hover affordance.
    out.push(`<div class="card-combo" role="group" aria-label="${esc(group.label)}">
        <span class="combo-label" title="${esc(group.tip)}" aria-hidden="true">${esc(group.label)}</span>
        <div class="combo-cards">${cards.join(`<span class="combo-plus" aria-hidden="true">+</span>`)}</div>
      </div>`);
  }
  return out.join("");
}

function renderZoneC({ indicators, readingsById }) {
  // Group by the server-served family list (order + label + desc from /api/families);
  // preserve /indicators order within each family. Metas whose `family` is undefined
  // (PENSION/BOTTOM ids) match no family and get no card here — unchanged.
  // Robustness fallback: /api/families is a SEPARATE serverless fn, so a deploy-skew /
  // cold 500 / network blip can leave `familyOrder` empty and blank all of Zone C. When
  // that happens, DERIVE the render order from the indicators' own `family` keys
  // (first-seen order over the already-fetched metas) so cards still render — the label
  // degrades to the raw key, no desc. No-op on the happy path (familyOrder non-empty).
  let order = state.familyOrder;
  if (order.length === 0) {
    const seen = new Set();
    order = [];
    for (const i of indicators) {
      if (i.family && !seen.has(i.family)) {
        seen.add(i.family);
        order.push({ key: i.family, label: i.family });
      }
    }
  }
  // The card-only display zones (pension-drawdown) need no local append: the served list
  // carries them as synthetic entries, and the fallback above derives them from the
  // metas' own `family` key (= cardGroupOf) when /api/families is cold.

  const groups = order.map((fam) => {
    // `/api/indicators` is registry-ordered, so the filter alone paints registry sequence.
    // `fam.ids` is the served RENDER RANK (ranked members, then that family's card-only overlay
    // ids); the cold-fallback order above carries none and falls through unsorted.
    const metas = sortByFamilyOrder(indicators.filter((i) => i.family === fam.key), fam.ids);
    if (metas.length === 0) return "";
    const cards = renderChannelCards(metas, readingsById);
    // Per-family feed-lag roll-up — the dashboard's mirror of the /lab tile-header
    // mark, at the WEAKER claim: a COUNT of members whose feed is behind, never a LAG/DEEP-LAG tier
    // (/api/status carries `lag`/`ageDays` but not the tier). Built from the family's OWN metas
    // joined to their readings, so it needs no wire change.
    const famLag = familyLagCountMark(
      metas.map((m) => ({ ...(readingsById.get(m.id) ?? {}), id: m.id, label: m.label })),
    );
    return `
      <div class="chan-group">
        <h3 class="chan-title" title="${esc(fam.desc ?? "")}">${esc(fam.label)}${famLag?.html ?? ""}</h3>
        <div class="card-grid">${cards}</div>
      </div>`;
  }).join("");

  return `<h2 title="${esc(LEGEND.indicators)}">Indicators</h2>${groups}`;
}

// --- Zone D: history charts (tabbed) ----------------------------------------

// Alert-level y-axis order + ranks come from /api/config's `alertRank` (served
// from ladder.ts) — derived per-chart, not hardcoded here.
const LADDER_RANGES = [30, 90, 365, 500]; // 500 = "all" (API caps /history at 500)
// CH/PLOT_W/PLOT_H/RIBBON_H/DETAIL_LIMIT geometry lives in chart-primitives.js.

// The persisted Zone D selection (`state.zoneD`) and the newest normalized view
// (`state.lastView`) live in the state container (D12).

// xAt/yAt/chartOpen/hoverLayer/scrubIndex live in chart-primitives.js.

/** Tab chrome + the active panel; fired on load, poll, and every interaction. */
function renderZoneD() {
  if (!state.lastView) return;
  const tabTip = { ladder: LEGEND.tabLadder, detail: LEGEND.tabDetail, bubble: LEGEND.tabBubble };
  const tabBtn = (id, text) =>
    `<button class="tab" role="tab" id="tab-${id}" data-tab="${id}" title="${esc(tabTip[id] ?? "")}"
       aria-selected="${state.zoneD.tab === id}" aria-controls="zone-d-panel"
       ${state.zoneD.tab === id ? 'tabindex="0"' : 'tabindex="-1"'}>${text}</button>`;

  setHTML(
    els.zoneD,
    `
    <div class="tabs" role="tablist" aria-label="History view">
      ${tabBtn("ladder", "Alert ladder")}
      ${tabBtn("detail", "Indicator detail")}
      ${tabBtn("bubble", "Bubble tier")}
    </div>
    <div class="tab-panel" id="zone-d-panel" role="tabpanel" tabindex="0"
      aria-labelledby="tab-${state.zoneD.tab}">
      <p class="chart-msg">Loading…</p>
    </div>`,
  );

  const panel = els.zoneD.querySelector("#zone-d-panel");
  // Return the panel-render promise so callers can scroll *after* the chart +
  // explainer land in the DOM (they're fetched async — see onCardActivate).
  if (state.zoneD.tab === "ladder") return renderLadderTab(panel);
  if (state.zoneD.tab === "bubble") return renderBubbleTab(panel);
  return renderDetailTab(panel);
}

/** Tab 1 — stepped alert-ladder line over /history with a range selector, carrying the shared
 *  crosshair/chip/hover-bar readout (`ladderChart` → `{ svg, detail }`, ladder-chart.js). */
async function renderLadderTab(panel) {
  setState("zoneD", { details: null }); // cleared until the fetched chart lands (a failed/empty fetch leaves it null — see onScrub bail)
  const limit = state.zoneD.ladderLimit; // capture before await — guards a rapid range re-click
  const token = guardToken(state, ["zoneD.tab", "zoneD.ladderLimit"]); // captured with `limit`
  const ranges = LADDER_RANGES.map((n) => {
    const label = n === 500 ? "all" : String(n);
    const on = limit === n;
    return `<button class="range${on ? " on" : ""}" data-range="${n}" title="${esc(LEGEND.range)}" aria-pressed="${on}">${label}</button>`;
  }).join("");
  const controls = `<div class="chart-controls"><span class="ctl-label" title="${esc(LEGEND.range)}">range</span>${ranges}</div>`;

  let alerts;
  try {
    alerts = await getJson(`${API}/history?limit=${limit}`, { timeoutMs: API_TIMEOUT_MS });
  } catch {
    alerts = null;
  }
  // Bail if the user switched tabs or picked another range while we awaited.
  if (!isCurrent(state, token)) return;

  if (!alerts) {
    setHTML(panel, `${controls}<p class="chart-msg">Couldn't load history.</p>`);
    return;
  }
  if (alerts.length === 0) {
    setHTML(panel, `${controls}<p class="chart-msg">No runs recorded yet - the gauge runs once each weekday.</p>`);
    return;
  }
  const cfg = state.lastView?.ladderConfig;
  if (!cfg) {
    setHTML(panel, `${controls}<p class="chart-msg">Ladder config unavailable.</p>`);
    return;
  }
  // The ladder now carries the SAME pointer readout the detail charts do: `ladderChart` returns
  // `{ svg, detail }`, the svg gets the slot marker onScrub pairs with `details[0]`, and the
  // single-chart CH geometry is what onScrub picks for a one-entry `details`.
  const { svg, detail } = ladderChart(alerts, cfg);
  setHTML(panel, `${controls}${svg.replace('<svg class="chart"', '<svg class="chart" data-chart-slot="0"')}`);
  setState("zoneD", { details: [detail] });
}

// P11.d: the indicator detail tab lives in the extracted seam (detail-tab.js) so /overview can
// render the SAME implementation; getters keep the seam's post-await lastView/familyOrder reads live.
const detailTabState = {
  get indicators() {
    return state.lastView.indicators;
  },
  get zoneD() {
    return state.zoneD;
  },
  get familyOrder() {
    return state.familyOrder;
  },
};
const detailTabDeps = {
  getMemberWeight,
  fetchSeries: getSeries,
  legSlot: true,
  topIndicatorsFor,
  guardToken,
  isCurrent,
  setState,
  setHTML,
  observe: observeRow,
};
// ONE shared observer fires each lazy detail row's cb once, on first near-viewport hit; no IO ⇒ eager.
const lazyRows = new Map(); // el → cb until its first intersect
const rowObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const cb = lazyRows.get(e.target);
            rowObserver.unobserve(e.target);
            lazyRows.delete(e.target);
            cb?.();
          }
        },
        { rootMargin: "200px" },
      )
    : null;
function observeRow(el, cb) {
  if (!rowObserver || !el) return void cb();
  // A re-render detaches the old stack's rows before they ever intersect — drop them here.
  for (const old of lazyRows.keys())
    if (!old.isConnected) {
      rowObserver.unobserve(old);
      lazyRows.delete(old);
    }
  lazyRows.set(el, cb);
  rowObserver.observe(el);
}
function renderDetailTab(panel) {
  return renderDetailTabImpl(panel, detailTabState, detailTabDeps);
}

/**
 * Tab 3 — the three slow bubble-state legs, each drawn by the SAME renderer the indicator-detail
 * tab uses (`detailChart` → the generic single-axis layout): value line, confirmed-state ribbon,
 * the leg's cut line(s) dashed with their labels, and the shared pointer readout (crosshair +
 * travelling chip + the one pinned `#hover-bar`), linked across all three charts by date.
 *
 * The cut lines are no longer composed here off /api/config `scoringCuts.slow`: each leg's served
 * `chart` spec already carries them as `displayBand`s baked from the same `src/slow.ts` constants
 * (`slowLegChart`, src/chart-rail.ts), so the chart spec is the ONE source and the hand-mirrored
 * label/cut table that used to live in `public/scoring-cuts.js` is gone with it.
 *
 * A leg whose meta the served list doesn't know, or that has no history yet, renders its own
 * message in that slot (a null `details` entry) — one dead row, never a dead stack.
 */
const BUBBLE_LEG_IDS = ["price-accel", "complacency-vix", "complacency-high"];

async function renderBubbleTab(panel) {
  setState("zoneD", { details: null }); // cleared until the stack lands — a stale entry from the tab we came off must never pair with a chart still in the DOM (see onScrub bail)
  const token = guardToken(state, ["zoneD.tab"]); // tab==="bubble" here
  const metas = state.lastView?.indicators ?? [];
  const charts = BUBBLE_LEG_IDS.map((id) => ({ id, meta: metas.find((m) => m.id === id) ?? null }));
  const fetched = await Promise.all(charts.map((c) => (c.meta ? fetchDetailSeries(c.meta, detailTabDeps) : null)));
  if (!isCurrent(state, token)) return; // tab moved on while awaiting

  // Three charts ⇒ the flush stack frame, exactly as the detail tab's compare/leg stacks: each
  // chart names itself in the SVG head band and its legend is re-slotted below the whole stack.
  // onScrub picks its scrub geometry off `details.length > 1`, so this MUST stay STACK_CH.
  const details = [];
  const legends = [];
  const blocks = charts.map((c, k) => {
    details[k] = null;
    const label = c.meta?.longLabel ?? c.meta?.label ?? c.id;
    const block = (inner) => `<div class="bubble-chart">${inner}</div>`;
    if (!c.meta) return block(`<p class="chart-msg">Unknown leg "${esc(c.id)}".</p>`);
    const series = fetched[k]?.series;
    const pts = series?.points ?? [];
    if (pts.length === 0)
      return block(`<p class="chart-msg">No history yet for ${esc(label)} - readings accrue daily.</p>`);
    const r = detailChart(
      { ...fetched[k].chartMeta, unit: series.unit, valueOnly: series.valueOnly, longLabel: series.longLabel },
      pts,
      {
        effAmber: series.effAmber,
        effRed: series.effRed,
        scorerLegs: series.scorerLegs,
        confirmCloses: series.confirmCloses,
        legBounds: series.legBounds,
      },
      { geo: STACK_CH },
    );
    details[k] = r.detail;
    const split = splitLegend(r.svg);
    legends.push(split.legend);
    // Slot marker pairs the svg with its `details[k]` entry in the delegated scrub handler.
    return block(split.chart.replace('<svg class="chart"', `<svg class="chart" data-chart-slot="${k}"`));
  });

  setHTML(panel, `<div class="bubble-charts">${blocks.join("")}</div>${legends.join("")}`);
  setState("zoneD", { details });
}

wireFitToggle(document);

// Zone D interactions: tab switch, ladder range, indicator pick.
els.zoneD.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab[data-tab]");
  if (tab) {
    setState("zoneD", { tab: tab.dataset.tab });
    void renderZoneD();
    return;
  }
  const range = e.target.closest(".range");
  if (range) {
    // `.range.win` (data-window) is the detail tab's window chip — never the ladder's data-range.
    if (range.classList.contains("win")) {
      setState("zoneD", { window: chipWindow(range.dataset.window) });
      writeDetailWindow(safeStorage(), state.zoneD.window);
      void renderDetailTab(els.zoneD.querySelector("#zone-d-panel"));
      return;
    }
    setState("zoneD", { ladderLimit: Number(range.dataset.range) });
    void renderLadderTab(els.zoneD.querySelector("#zone-d-panel"));
  }
});
els.zoneD.addEventListener("change", (e) => {
  if (e.target.classList.contains("ind-picker")) {
    // "" (— none —) clears the indicator only; it must NOT also clear the leg, or the panel
    // would empty out. Picking a real indicator still leaves leg mode, as before.
    setState("zoneD", e.target.value ? { indicatorId: e.target.value, legId: null } : { indicatorId: null });
    void renderDetailTab(els.zoneD.querySelector("#zone-d-panel"));
  }
  if (e.target.classList.contains("leg-picker")) {
    setState("zoneD", { legId: e.target.value || null }); // "" (— none —) clears back to compare view
    void renderDetailTab(els.zoneD.querySelector("#zone-d-panel"));
  }
  if (e.target.classList.contains("leg-chart-pos")) {
    // Persist + re-render: legChartPos is a detail-tab guard token, so this repaints like a legId pick.
    const legChartPos = Number(e.target.value);
    writeLegChartPos(safeStorage(), legChartPos);
    setState("zoneD", { legChartPos });
    void renderDetailTab(els.zoneD.querySelector("#zone-d-panel"));
  }
  if (e.target.classList.contains("ind-picker-compare")) {
    // Fresh array, never in-place: `isCurrent` compares token fields by `===`,
    // so an in-place `compareIds[slot] =` write would leave every guard token inert.
    const next = [...state.zoneD.compareIds];
    next[Number(e.target.dataset.slot)] = e.target.value || null;
    setState("zoneD", { compareIds: next });
    void renderDetailTab(els.zoneD.querySelector("#zone-d-panel"));
  }
});
// Roving tablist: ←/→ (and Home/End) move between the three history tabs (WAI-ARIA).
// Scoped to [data-tab] so any other `.tab` on the panel isn't swept in.
els.zoneD.addEventListener("keydown", (e) => {
  if (!e.target.matches(".tab[data-tab]")) return;
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const tabs = [...els.zoneD.querySelectorAll(".tab[data-tab]")];
  const cur = tabs.indexOf(e.target);
  const move = keys[e.key];
  const next =
    move === "first" ? 0 : move === "last" ? tabs.length - 1 : (cur + move + tabs.length) % tabs.length;
  setState("zoneD", { tab: tabs[next].dataset.tab });
  void renderZoneD();
  els.zoneD.querySelector(".tab[data-tab][aria-selected=true]")?.focus();
});

// Pointer-driven detail-chart readout (crosshair + travelling chip + the pinned #hover-bar).
// The seam itself lives in hover-readout.js so /overview wires the SAME implementation.
wireHoverReadout({
  host: els.zoneD,
  bar: els.hoverBar,
  getDetails: () => state.zoneD.details,
});

// --- Render dispatch + data normalization -----------------------------------

// Note: the parameter is the fetch payload, NOT the module state container —
// named `payload` so `state.lastView` below refers to the container (D12).
let deepLinkPending = true; // the boot `?ind=` intake fires once (render below)

function render(payload) {
  els.message.hidden = true;
  els.banner.hidden = true;
  els.dashboard.hidden = false;
  els.zoneBottom.hidden = false; // un-hide the zones the loading skeleton suppressed
  els.zoneSlow.hidden = false;
  els.zoneD.hidden = false;

  const readingsById = new Map(payload.status.readings.map((r) => [r.indicatorId, r]));
  const view = {
    verdict: payload.status.verdict,
    asOf: payload.status.asOf,
    provisional: payload.status.provisional,
    lag: payload.status.lag,
    feedAgeDays: payload.status.feedAgeDays,
    feedsLagging: payload.status.feedsLagging,
    laggingFeedIds: payload.status.laggingFeedIds,
    feedsTotal: payload.status.feedsTotal,
    history: payload.history,
    indicators: payload.indicators,
    ladderConfig: payload.ladderConfig,
    readingsById,
  };

  setState({ lastView: view }); // Zone D interactions/polls redraw from this (identity preserved)
  setHTML(els.zoneA, renderZoneA(view));
  renderZoneBottom(view); // sync — fills els.zoneBottom itself
  void renderZoneSlow(view); // async (reads /series) — fills els.zoneSlow itself
  setHTML(els.zoneC, renderZoneC(view));
  // Cold danger model: repaint Zone C once it lands so the ⌁ note appears (no-op on failure / old payload).
  if (!state.deadLitIds) void getMemberWeight().then(() => state.deadLitIds && setHTML(els.zoneC, renderZoneC(state.lastView)));
  // `?ind=<id>` deep link (a /lab chip's "Open … indicator detail" row, detail-jump.js): consumed
  // on the FIRST paint only, validated against the served metas — an unknown id keeps the prompt.
  // onCardActivate renders Zone D itself (then scrolls), so it replaces the plain render here.
  const deepId = deepLinkPending ? deepLinkIndicatorId(location.search, view.indicators) : null;
  deepLinkPending = false;
  if (deepId) void onCardActivate(deepId);
  else void renderZoneD();
}

// --- Fetch cycle: one pass updates all zones --------------------------------

async function fetchAll() {
  // Request order (first load: /status beside the fan-out; refocus: /status alone) → load-cycle.js (P4).
  const r = await loadDashboard({
    api: API,
    vintage: state.vintage,
    storage: safeStorage(),
    mult: MULT,
    getConfig,
    getFamilies,
    onFull: () => state.seriesCache.clear(), // the vintage moved (or first paint): every cached series is the old vintage's
    fetch: fetchOnceVia(apiFetch),
  });
  if (r.kind === "empty") return showEmpty(); // no runs recorded yet
  if (r.kind === "error") return showError();
  const { status, next } = r;
  if (r.kind === "stop") {
    // The verdict is unchanged, but `lag`/`feedAgeDays`/the feeds pill are recomputed per request
    // (ages vs. today) — repaint Zone A from the fresh body so a tab left open over a weekend
    // still shows a feed going stale. Everything else on screen is a function of the vintage.
    if (state.lastView) setHTML(els.zoneA, renderZoneA({ ...state.lastView, ...statusPills(status) }));
    return;
  }
  if (r.kind === "stored") {
    // P9.2 restore paint — no series cache is seeded.
    const { stored } = r;
    setState({ familyOrder: stored.families, ladderConfig: stored.config });
    render({ status, indicators: stored.indicators, history: stored.history, ladderConfig: stored.config });
    setState({ vintage: next }); // painted — only now may a refocus stop short
    return;
  }
  try {
    render({ status, indicators: r.indicators, history: r.history, ladderConfig: r.config });
    // Painted — ONLY now may a refocus stop short. Set any earlier and a failed fan-out would be
    // vintage-locked until firedAt moves (next weekday), with showError's "retries when you switch
    // back" promise broken.
    setState({ vintage: next });
    persistBoot();
  } catch {
    return showError();
  }
}

/** The per-request (wall-clock) fields of a /status body — the ones a same-vintage refocus must repaint. */
function statusPills(status) {
  return {
    lag: status.lag,
    feedAgeDays: status.feedAgeDays,
    feedsLagging: status.feedsLagging,
    laggingFeedIds: status.laggingFeedIds,
    feedsTotal: status.feedsTotal,
  };
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** P9.2 — persist the painted vintage's boot bundle (metas, history, config, families). */
function persistBoot() {
  const view = state.lastView;
  if (!view || !state.vintage) return;
  writeBoot(safeStorage(), {
    vintage: state.vintage,
    mult: MULT,
    indicators: view.indicators,
    history: view.history,
    config: state.ladderConfig,
    families: state.familyOrder,
  });
}

// --- Card click: open that indicator in Zone D's detail tab -----------------

async function onCardActivate(id) {
  setState("zoneD", { tab: "detail", indicatorId: id, legId: null });
  const token = guardToken(state, ["zoneD.tab", "zoneD.indicatorId"]); // tab==="detail", indicatorId===id here
  // Await the full detail render (chart + explainer) before scrolling, then
  // align Zone D's *bottom* to the viewport so the description text is visible,
  // not just the header.
  await renderZoneD();
  if (!isCurrent(state, token)) return; // selection moved on
  els.zoneD.scrollIntoView({ behavior: "smooth", block: "end" });
}

// Delegated on #dashboard, not zone-C: the pension / VIX-bottom / bubble leg cards
// live in their own zones and are just as clickable. `.card[data-id]` is the whole
// contract — zone-C's loading skeletons are `.skel-card` and zone D hosts no card at
// all, so the widened scope is inert there.
//
// The ⓘ exclusion is NOT redundant with the capture-phase help handler. That handler
// stops the *click*, so a glyph tap never reaches here — but the glyph is a real
// <button> nested inside the card, so a keyboard Enter/Space on a focused glyph fires
// a keydown that bubbles here on its own, matches the ancestor card, and would BOTH
// open the help bar and navigate. Excluding glyph descendants is what suppresses the
// keyboard path the way stopPropagation suppresses the pointer one.
function cardTarget(e) {
  if (e.target.closest(`.${HELP_GLYPH_CLASS}`)) return null;
  return e.target.closest(".card[data-id]");
}
els.dashboard.addEventListener("click", (e) => {
  const card = cardTarget(e);
  if (card) void onCardActivate(card.dataset.id);
});
els.dashboard.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = cardTarget(e);
  if (card) {
    e.preventDefault();
    void onCardActivate(card.dataset.id);
  }
});

// --- Mobile help: inject a ⓘ glyph on every [title], read it into #help-bar --
// This IS the canonical tooltip system — to add a tooltip just set a `title=`;
// don't build a popover. The `title=` strings stay the single source of truth
// (esc()'d already). Nested [title] hosts don't collide: the glyph is a direct
// child, so glyph.closest("[title]") resolves to the nearest titled ancestor and
// the `:scope > .help-i` guard (below) blocks a double-decorate. A tap
// on a glyph funnels its host's title into the one fixed help bar, so touch
// devices reach the same help desktop gets on hover.

// The one seam for a zone-level markup write — `setHTML` now lives in help-bar.js
// (imported above); its docblock carries the scroll-clamp contract.

// --- Refetch: on load + when the tab regains focus --------------------------
// No interval: the data behind /status moves once per weekday (cron 0 22 * * 1-5),
// so a foreground poll re-fetched identical bytes up to ~1,440×/day. A tab pinned
// in the foreground across 22:00 UTC won't auto-update until refocused — accepted.
// P9: the refocus fetches /status alone and stops on an unchanged vintage (fetchAll); going
// hidden persists the boot bundle so the NEXT page load can paint from storage (P9.2).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") fetchAll();
  if (document.visibilityState === "hidden") persistBoot();
});
window.addEventListener("pagehide", persistBoot);

// --- Boot -------------------------------------------------------------------

showLoading();
fetchAll().finally(() => dropPrefetches()); // a boot prefetch the boot cycle left untaken never reaches a refocus
wireHelpBar(els.dashboard, els.helpBar); // document-level help handlers (capture click + Escape)
decorateHelp(els.dashboard); // initial pass for whatever is already in the DOM
