/*
 * overview.js — the public read-only /overview page (P11.e). Four sections, nothing else —
 * no scenario knobs, no replay, no sparks, no what-if slider: (1) alert-band Floors
 * (band-panel.js, fed d.band), (2) the Families board (families-board.js, read-only — no
 * deps.interactive ⇒ no click-to-cycle, zero listeners), (3) the Danger Ledger
 * (lab-board.js renderDangerField, as-is), (4) the Indicator detail tab (detail-tab.js —
 * the SAME implementation the dashboard runs, with a series fetcher that composes
 * /api/series?id&limit&detail=1 URLs and threads NO what-if multiplier).
 *
 * Anonymous load = exactly 5 edge requests, all edge-cacheable:
 *   /api/status            — the P9 refocus gate (vintageOf/refetchPlan; a refocus on an
 *                            unchanged vintage stops after this ONE request; the first load
 *                            fires it beside the four below — load-cycle.js, P4)
 *   /api/lab?hist=20       — the board payload; byte-identical URL to lab.js's live fetch
 *                            (LAB_LOOKBACK, one shared constant) so the edge cache key is
 *                            SHARED with /lab
 *   /api/families          — served family order (detail-tab picker optgroups)
 *   /api/indicators        — indicator meta list (detail-tab pickers + charts)
 *   /api/danger-model      — ONE fetch, two consumers: the ledger's signal grid
 *                            (loadDangerModel) and the detail explainer's memberWeight
 * No selection at boot ⇒ the detail tab paints its "Pick an indicator." prompt and fetches
 * nothing; an explicit leg pick adds up to TOP_N (10) cached /api/series reads.
 *
 * The P11 gate: /overview is the page gated visitors are SENT TO — it NEVER gates or redirects.
 */
import { createState, guardToken, isCurrent } from "./app-state.js";
import { API_TIMEOUT_MS, getJson } from "./http.js";
import { vintageOf } from "./refetch-gate.js";
import { loadOverview } from "./load-cycle.js";
import { chipDetailTarget } from "./detail-jump.js";
import { setHTML, wireHelpBar } from "./help-bar.js";
import { renderBandPanel } from "./band-panel.js";
import { renderFamiliesBoard } from "./families-board.js";
import {
  buildBandPanel,
  buildDangerField,
  breakerFootHtml,
  dangerFieldSkeletonHtml,
  dangerModel,
  loadDangerModel,
  renderDangerField,
  resolveField,
} from "./lab-board.js";
import { renderDetailTab, chipWindow, readDetailWindow, writeDetailWindow } from "./detail-tab.js";
import { wireFitToggle } from "./fit-toggle.js";
import { wireHoverReadout } from "./hover-readout.js";
import { secTip } from "./section-tips.js";
import { topIndicatorsFor } from "./leg-top.js";

const els = {
  message: document.getElementById("message"),
  main: document.getElementById("overview"),
  bandHost: document.getElementById("bandPanelHost"),
  board: document.getElementById("familiesBoard"),
  dangerField: document.getElementById("dangerField"),
  zoneD: document.getElementById("zone-d"),
  zoneDHead: document.getElementById("zone-d-head"),
  hoverBar: document.getElementById("hover-bar"),
};

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const { state, setState } = createState({
  vintage: null, // last painted /status firedAt+deployId — refetchPlan stops a same-vintage refocus
  seriesCache: new Map(), // in-place mutation like app.js — cache entries are not render state
  indicators: [], // /api/indicators meta list (detail-tab `state.indicators`)
  familyOrder: [], // /api/families order (detail-tab picker optgroups)
  // legId null ⇒ the tab boots on its "Pick an indicator." prompt and fires ZERO /api/series
  // fetches; series load only on an explicit leg/indicator pick.
  zoneD: {
    tab: "detail",
    window: readDetailWindow(safeStorage()), // global window-chip trailing-N draw slice (chipWindow; null = the default ~2y span), persisted
    indicatorId: null,
    legId: null,
    compareIds: [null, null],
    details: null,
  },
});

/* ------------------------------------------------------------------ skeleton (once) */
// The danger-ledger skeleton: dangerFieldSkeletonHtml (lab-board.js) — the SAME producer lab.js
// buildBench interpolates, so the two pages cannot fork. Zero fetches here.
function buildSkeleton() {
  setHTML(els.dangerField, dangerFieldSkeletonHtml());
  buildDangerField(null); // wires the delegated legend/region/attrib toggles on #dangerField
  buildBandPanel(); // wires the delegated disclosure clicks on #bandPanelHost
  // The detail section's own title. /lab has no such heading (its Zone D is the reader), so this
  // is the one sec-tip host rendered from this file — same three pieces as the rest: the copy in
  // section-tips.js, the `sec-tip` class beside the title, the `.lab .sec-tip[title]` carve-out.
  setHTML(
    els.zoneDHead,
    `<h2 class="zd-title sec-tip"${secTip("indicatorDetail")}>Indicator detail</h2>`,
  );
}

/* ------------------------------------------------------------------ detail tab (seam) */
// Series fetcher for detail-tab.js — app.js's getSeries minus the page-level what-if
// multiplier: this page composes plain /api/series?id&limit[&detail=1][&from=] URLs only.
async function fetchSeries(id, limit, detail = false, from = null) {
  const detailKey = detail ? `${id}:${limit}:detail` : `${id}:${limit}`;
  const key = from ? `${detailKey}:from${from}` : detailKey;
  if (state.seriesCache.has(key)) return state.seriesCache.get(key);
  const detailQ = detail ? "&detail=1" : "";
  const fromQ = from ? `&from=${encodeURIComponent(from)}` : "";
  try {
    const data = await getJson(`/api/series?id=${encodeURIComponent(id)}&limit=${limit}${detailQ}${fromQ}`, { timeoutMs: API_TIMEOUT_MS });
    state.seriesCache.set(key, data);
    return data;
  } catch {
    state.seriesCache.set(key, null);
    return null;
  }
}

const detailDeps = {
  // ONE /api/danger-model fetch serves both the ledger's signal grid and this explainer:
  // loadDangerModel is idempotent and dangerModel is the whole served body.
  getMemberWeight: async () => {
    await loadDangerModel();
    return (dangerModel && dangerModel.memberWeight) || null;
  },
  fetchSeries,
  topIndicatorsFor,
  guardToken,
  isCurrent,
  setState,
  setHTML,
};

function renderDetail() {
  return renderDetailTab(
    els.zoneD.querySelector("#zone-d-panel"),
    state,
    detailDeps,
  );
}

// Window chips (F1, 2026-09-13): the chip row renders here too (shared renderDetailTab), so the
// SAME delegated `.range.win` branch app.js wires must move `zoneD.window` on this page as well.
els.zoneD.addEventListener("click", (e) => {
  const range = e.target.closest(".range.win");
  if (range) {
    setState("zoneD", { window: chipWindow(range.dataset.window) });
    writeDetailWindow(safeStorage(), state.zoneD.window);
    void renderDetail();
  }
});
// Picker interactions — the same three delegated branches app.js wires on its Zone D host.
els.zoneD.addEventListener("change", (e) => {
  if (e.target.classList.contains("ind-picker")) {
    setState(
      "zoneD",
      e.target.value
        ? { indicatorId: e.target.value, legId: null }
        : { indicatorId: null },
    );
    void renderDetail();
  }
  if (e.target.classList.contains("leg-picker")) {
    setState("zoneD", { legId: e.target.value || null });
    void renderDetail();
  }
  if (e.target.classList.contains("ind-picker-compare")) {
    // Fresh array, never in-place: isCurrent compares token fields by ===.
    const next = [...state.zoneD.compareIds];
    next[Number(e.target.dataset.slot)] = e.target.value || null;
    setState("zoneD", { compareIds: next });
    void renderDetail();
  }
});

// Pointer-driven detail-chart readout — the SAME seam app.js wires over its own Zone D
// (hover-readout.js). Delegated on the stable #zone-d host, so it survives the panel's
// innerHTML re-render on every pick; `details` is read live off the state slice detail-tab.js
// writes back through `setState("zoneD", { details })`.
wireHoverReadout({
  host: els.zoneD,
  bar: els.hoverBar,
  getDetails: () => state.zoneD.details,
});

/* ------------------------------------------------------------------ fetch + render */
function showError() {
  els.message.textContent =
    "Couldn't load the overview - it retries when you switch back to this tab.";
  els.message.hidden = false;
}

function render(d) {
  // Anti-fake-calm (lab.js applyBoard's guard, live only): with NO live feed this run the mean
  // contribution (0) would paint a misleading "Calm" board — show the no-data state instead.
  if (d.liveFamilyCount === 0) {
    els.message.textContent =
      "No live family feeds in the latest run - danger can't be assessed.";
    els.message.hidden = false;
    els.main.hidden = true;
    return;
  }
  // (1) Floors — d.band is LIVE-ONLY; an absent band keeps the host :empty (collapsed by CSS),
  // and the micro-label rides inside the host only when the panel renders (lab.js's pattern).
  const bandHtml = renderBandPanel(d.band);
  setHTML(
    els.bandHost,
    bandHtml
      ? `<span class="lg-sectag" aria-hidden="true">Alert band</span>${bandHtml}`
      : "",
  );
  // (2) Families board — read-only: no deps.interactive ⇒ no .clickable, zero listeners.
  renderFamiliesBoard(els.board, d);
  // (3) Danger ledger — resolveField once, exactly as lab.js's applyBoard does. Then the R4
  // cash breaker: same computed driver as lab.js (no method cards here ⇒ never scripted) —
  // tone "alert" IS r4.cash (src/lab-overlays.ts's r4View), flipping .breaker + the footer to the
  // shared Cash-override base (breakerFootHtml, lab-board.js).
  renderDangerField(resolveField(d), d);
  const breaker = d.overlays?.r4?.tone === "alert";
  els.dangerField.classList.toggle("breaker", breaker);
  if (breaker) setHTML(document.getElementById("dfFoot"), breakerFootHtml(d));
  els.message.hidden = true;
  els.main.hidden = false;
  // (4) Indicator detail tab (async — fetches its own /api/series per pick).
  void renderDetail();
}

async function loadAll() {
  // Request order (first load: /status beside the board fetches; refocus: /status alone) → load-cycle.js (P4).
  const r = await loadOverview({ vintage: state.vintage, loadDangerModel });
  if (r.kind === "stop") return;
  if (r.kind === "error") return showError();
  setState({ familyOrder: r.familyOrder, indicators: r.indicators });
  render(r.d);
  // Painted — only now may a refocus stop short (a failed load above retries on the next refocus).
  setState({ vintage: vintageOf(r.status) });
}

// Refocus: /status alone, stopping on an unchanged vintage (P9) — no interval, like app.js.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadAll();
});

/* ------------------------------------------------------------------ boot */
buildSkeleton();
wireFitToggle(document);
// Families-board chip → Indicator detail: the sheet's action row jumps IN-PAGE (Zone D lives
// here), the same set-state → await render → scroll shape as app.js's onCardActivate.
wireHelpBar(els.main, document.getElementById("help-bar"), {
  detailAction: (host) => chipDetailTarget(host, { metas: state.indicators }),
  onDetail: async (id) => {
    setState("zoneD", { indicatorId: id, legId: null });
    const token = guardToken(state, ["zoneD.indicatorId"]);
    await renderDetail();
    if (!isCurrent(state, token)) return; // picker moved on during the /api/series await
    els.zoneD.scrollIntoView({ behavior: "smooth", block: "end" });
  },
});
loadAll();
