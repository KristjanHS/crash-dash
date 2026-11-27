/*
 * detail-tab.js — the Zone D "Indicator detail" tab (indicator/leg pickers + chart stack +
 * compare slots), extracted MOVE-ONLY from app.js (P11.d) so /overview can render the SAME
 * implementation. `renderDetailTab(panel, state, deps)`:
 *
 *   state — read LIVE at the exact points the old app.js closure read them (post-await):
 *     .indicators   the served /api/indicators meta list (app.js passes a getter over
 *                   `state.lastView.indicators`)
 *     .zoneD        the live selection slice — reads `indicatorId`, `legId`, `compareIds`;
 *                   the guard token also snapshots `tab`
 *     .familyOrder  the served /api/families list (picker optgroup order)
 *   deps —
 *     getMemberWeight()                      async → memberWeight|null (/api/danger-model)
 *     fetchSeries(id, limit, detail?, from?) async → series|null — the caller's series fetcher
 *                                            (app.js: getSeries, with its cache + page MULT)
 *     legSlot                                OPTIONAL — `true` ⇒ leg mode adds the leg's LEG_CHART_ID
 *                                            indicator chart + the "leg chart at" picker; absent
 *                                            (/overview) ⇒ members-only stack
 *     topIndicatorsFor(legKey, memberWeight) leg-top.js (via deps so /overview can swap ranking)
 *     guardToken(state, paths), isCurrent(state, token)  app-state.js, over THIS `state`
 *     setState(slice, patch)                 called exactly as `setState("zoneD", { details })`
 *     setHTML(el, html)                      OPTIONAL — defaults to help-bar.js's export, the one
 *                                            [title]-capable writer (write-seam.test.js)
 *     observe(el, cb)                        OPTIONAL — fire `cb` once when `el` first nears the viewport.
 *                                            Present ⇒ a leg stack's rows fetch lazily; absent ⇒ eager
 *
 * `mult` contract: this seam composes no series URL and threads NO mult through `fetchSeries` —
 * the `?mult=` what-if lives entirely inside the caller's fetcher (app.js bakes its page-level
 * MULT into getSeries). A caller with no mult override (/overview) therefore emits series URLs
 * with no `&mult=`; the only trace here is `series.mult` read back for the whatIfBadge, which
 * renders "" when the server echoed none.
 */
import { esc, CH, STACK_CH, DETAIL_LIMIT, LONG_WINDOW } from "./chart-primitives.js";
import { floorMonthStart } from "./month-grid.js";
import { setHTML } from "./help-bar.js";
import { INDICATOR_DESC } from "./indicator-desc.js";
import { idIfDistinct } from "./leading-name.js";
import { legImpactClauses } from "./leg-impact.js";
import { TOP_N, OFF_LADDER_LEGS, OFF_LADDER_LABEL } from "./leg-top.js";
import { LEG_DESC } from "./leg-desc.js";
import { linkList, holdingList } from "./ext-links.js";
import { detailChart, splitLegend } from "./detail-chart.js";
import { placeLegChart, LEG_CHART_ID, LEG_CHART_POSITIONS } from "./leg-chart.js";
import { whatIfBadge } from "./format.js";
import { sleeveLabel } from "./sleeve-label.js";
import { groupMetasByFamily } from "./picker-groups.js";

/** Chip dataset value -> zoneD.window: "default" => null (the id's own ~2y DETAIL_LIMIT slice), else trading days. */
export const chipWindow = (v) => (v === "default" ? null : Number(v));
// The null chip is the default span, labelled by its length (DETAIL_LIMIT ≈ 2y); `5y` expands past it.
const WINDOW_CHIPS = [[63, "3m"], [126, "6m"], [252, "1y"], [null, "2y"], [LONG_WINDOW, "5y"]];
/** The ONE global window-chip row atop #zone-d-panel; the tail's `.touch-hint` is hover:none-only. */
const windowChipRow = (active) =>
  `<div class="chart-controls win-controls">${WINDOW_CHIPS.map(
    ([w, t]) => `<button class="range win" data-window="${w ?? "default"}" aria-pressed="${w === active}">${t}</button>`,
  ).join("")}<span class="touch-hint">tap to read</span></div>`;

/** localStorage key for the persisted window chip — exported so both wiring pages and the tests name it once. */
export const DETAIL_WINDOW_KEY = "dash.detailWindow";
const isChipWindow = (w) => WINDOW_CHIPS.some(([cw]) => cw === w);

/** The persisted window chip as a zoneD.window value; null (the default ~2y span) when missing, invalid or blocked. */
export function readDetailWindow(storage) {
  try {
    const v = storage.getItem(DETAIL_WINDOW_KEY);
    if (v != null && isChipWindow(chipWindow(v))) return chipWindow(v);
  } catch {
    // blocked (private mode / disabled storage) ⇒ fall through to the default
  }
  return null;
}

/** Persist a zoneD.window value; a no-op for a non-chip value and for a throwing storage. */
export function writeDetailWindow(storage, w) {
  if (!isChipWindow(w)) return;
  try {
    storage.setItem(DETAIL_WINDOW_KEY, String(w ?? "default"));
  } catch {
    // blocked storage ⇒ swallow; the chip simply won't survive the reload
  }
}

// Date-anchored detail window (ChartSpec.fromDays ids). MAX matches the server cap — the
// payload is bounded by the [from, now] window, not by this, so the recompute branches simply
// fetch enough history to reach the anchor. PAD (calendar days) warms the deepest client-side
// windowed compute among the aligned ids (F1's 30-trading-day roc30 ≈ 44 cal days; F13's d20 leg is
// a 20-trading-day `trailingReturn` ≈ 28 cal days). F13's ms50 line needs none — it rides the
// server-persisted `decision` — but its SECOND leg is client-computed, so the pad is load-bearing
// for it: shrink the pad below ~44 cal days and both those legs gap at the window's left edge.
const DETAIL_MAX_LIMIT = 4000;
const DETAIL_FROM_PAD_DAYS = 60;
/** The chip's window when it EXPANDS past the default span (`5y`), else 0 — narrower chips never widen a fetch. */
const expandingWindow = (w) => (w != null && w > DETAIL_LIMIT ? w : 0);
/** ISO (YYYY-MM-DD) `n` calendar days before today — the client-side date anchor. */
function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** `{ID}` → esc'd served label (bare id when unknown/unloaded); the surrounding prose is esc'd too. */
export function withLabels(text, metas) {
  const labelById = new Map(metas.map((m) => [m.id, m.label]));
  return text
    .split(/(\{[A-Za-z0-9_-]+\})/)
    .map((part) => {
      const t = /^\{([A-Za-z0-9_-]+)\}$/.exec(part);
      return t ? esc(labelById.get(t[1]) ?? t[1]) : esc(part);
    })
    .join("");
}

/**
 * Explainer block under the detail chart — labeled sub-blocks:
 * "Why it matters." (why), "When it misleads" (lies, optional) and "Read it with." (with,
 * optional — its `{ID}` tokens resolve to each sibling's SERVED label off `metas`, the leg-desc.js
 * pattern; unknown id ⇒ the bare id). The chart's amber/red band labels carry the live cut-points,
 * so none of this prose restates a threshold and it can't drift from the engine's math. The
 * derived "In the engine." role line was removed 2026-09-12 (slice 2b): it restated the ladder block.
 */
function indicatorBlurb(meta, memberWeight = null, metas = []) {
  const d = INDICATOR_DESC[meta.id];
  if (!d) return "";
  // Optional: known failure modes — when the signal misleads. Hand-authored constant, esc'd anyway.
  const lies = d.lies ? `<p><strong>When it misleads.</strong> ${esc(d.lies)}</p>` : "";
  // "Read it with." — hand-authored sibling cross-checks; the `{ID}` tokens are substituted with
  // each sibling's SERVED label (esc'd — served data), the rest of the string is esc'd as a whole.
  const withText = d.with ? withLabels(d.with, metas) : "";
  const readWith = withText ? `<p><strong>Read it with.</strong> ${withText}</p>` : "";
  // Which ladder sleeves this member is weighted onto, DERIVED from the engine's served
  // MEMBER_WEIGHT row — never a hand-typed roster here. Omitted when the model hasn't loaded or
  // the member reaches no leg (context-only ids carry no row).
  const clauses = legImpactClauses(memberWeight?.[meta.id]);
  const legs = clauses.length
    ? `<p><strong>Where it lands on the ladder.</strong> ${clauses
        .map((c) => `${esc(c.label)}: ${c.sleeves.map((sl) => esc(sleeveLabel(sl))).join(", ")}`)
        .join(" · ")}. Read live from the danger engine's own cross-leg magnitudes - it is how hard
        a confirmed reading here weighs on each sleeve, not a forecast of returns.</p>`
    : "";
  // `why` is a static, hand-authored trusted constant rendered raw (a
  // future contributor adding any dynamic/API-sourced text to them must add esc()
  // — every other interpolated field here is esc'd.
  const aboutName = [idIfDistinct(meta.label, meta.id), meta.label].filter(Boolean);
  const chartLinks = linkList(d.links);
  const charts = chartLinks ? `<p class="ext-links"><strong>Live charts.</strong> ${chartLinks}</p>` : "";
  return `<section class="ind-about" aria-label="About ${esc(aboutName.join(" "))}">
    <h4>About ${aboutName.map(esc).join(" · ")}</h4>
    ${charts}
    <p><strong>Why it matters.</strong> ${d.why}</p>
    ${lies}
    ${readWith}
    ${legs}
  </section>`;
}

// Leg-stack description block (leg-desc.js): a CLOSED <details> carrying the leg's basis + why,
// rendered above the leg-source provenance line in leg mode. `basis`/`why` are trusted hand-authored
// constants rendered RAW; the `{ID}` tokens in `why` are substituted with each indicator's SERVED
// label off `metas` (unknown/unloaded id ⇒ the bare id), and those labels come from served data so
// they are esc()'d — no hand-typed indicator label lives in leg-desc.js. No-row sleeve ⇒ "".
function legDescBlock(legKey, metas) {
  const d = LEG_DESC[legKey];
  if (!d) return "";
  const labelById = new Map(metas.map((m) => [m.id, m.label]));
  const why = d.why.replace(/\{([A-Za-z0-9_-]+)\}/g, (_, id) => esc(labelById.get(id) ?? id));
  // The top-holdings chart line sits OUTSIDE the closed <details> so it reads without a click.
  const held = holdingList(d.holdings);
  const holdings = held ? `<p class="ext-links leg-holdings"><strong>Top holdings.</strong> ${held}</p>` : "";
  // Count-free on purpose: the seat count has moved once (5 -> 8) and a numeral here went stale
  // in the copy while the stack stayed correct. leg-top.test.js pins the prose to the row set.
  return `${holdings}<details class="leg-desc"><summary>Why these indicators</summary>
    <p class="leg-basis">${d.basis}</p>
    <p class="leg-why">${why}</p></details>`;
}

/** Per-`state` render generation: a lazy row whose render was superseded must not paint. */
const renderGen = new WeakMap();

/** Tab 2 — value/Δ20 line + threshold bands + state ribbon for one indicator. */
export async function renderDetailTab(panel, state, deps) {
  const write = deps.setHTML ?? setHTML;
  // Hoisted above the `!meta` return: the leg picker derives its option list from the served
  // memberWeight row keys (never a hand-typed roster — the leg-impact.js rule). Cached after the
  // first success, so this awaits the network only once per page session.
  // Awaited FIRST: every state read feeding the paint (metas, indicatorId → meta) must happen
  // after the last await, or the guard token snapshots newer state than the paint uses.
  const weights = await deps.getMemberWeight();

  const metas = state.indicators;
  // NO auto-default: the picker opens on "— none —" (the default view is the default LEG's stack,
  // DEFAULT_LEG). An indicator is charted only once one is picked (or a Zone C card is clicked).
  const meta = metas.find((m) => m.id === state.zoneD.indicatorId);

  // The picker paints the SAME family grouping + impact rank as the Zone C cards.
  // `<optgroup>` gives the family heading for free; the served family list carries
  // the card-only zones + overlay rank itself, so the dropdown mirrors the card
  // grid's zones one-for-one with no local zone table, and anything the served list doesn't
  // claim lands in one trailing group rather than vanishing.
  // The ETFs group (`pension-drawdown`) shows the label alone: those labels are already
  // "short leg name + ticker" (`EU-Fin EXSH`), so the internal id (`LEGP_EUFIN`) is noise there.
  const optionHtml = (m, selectedId, bareLabel) =>
    `<option value="${esc(m.id)}"${m.id === selectedId ? " selected" : ""}>${esc(
      (bareLabel && m.label) || [m.label, idIfDistinct(m.label, m.id)].filter(Boolean).join(" "),
    )}</option>`;
  const optgroupsHtml = (selectedId) =>
    groupMetasByFamily(metas, state.familyOrder)
      .map(
        (g) =>
          `<optgroup label="${esc(g.label)}">${g.items
            .map((m) => optionHtml(m, selectedId, g.key === "pension-drawdown"))
            .join("")}</optgroup>`,
      )
      .join("");
  const picker = `<div class="chart-controls"><span class="ctl-label" title="Choose which indicator's history to plot.">indicator</span>
    <select class="ind-picker" aria-label="indicator">
      <option value=""${state.zoneD.indicatorId ? "" : " selected"}>&mdash; none &mdash;</option>
      ${optgroupsHtml(state.zoneD.indicatorId)}
    </select></div>`;
  // Leg picker: selecting a leg replaces the stack with that leg's top indicators
  // (leg-top.js). Options DERIVED from the served memberWeight rows — a first-seen key union,
  // since rows are partial; disabled with a note while the model is cold or its fetch failed.
  const legKeys = [];
  if (weights)
    for (const row of Object.values(weights))
      for (const k of Object.keys(row)) if (!legKeys.includes(k)) legKeys.push(k);
  // On the LABEL only, never on the `<select>` beside it: `decorateHelp` appends the ⓘ as a CHILD
  // of the titled host, and a `<select>` renders no child but `option`/`optgroup` — measured 0×0,
  // i.e. a tooltip with no mobile path at all. The `.ctl-label` carries the same text and IS
  // tap-readable (`#zone-d .ctl-label[title]`, HELP_CARVEOUT_SELECTOR); the select keeps its
  // `aria-label`. Same reason the two indicator pickers below dropped theirs.
  // Count DERIVED from TOP_N — the seat count has moved once (5 -> 8) and this copy went
  // stale-by-construction when it carried a literal.
  const legTitle = `Replace the chart with the ${TOP_N} indicators that most affect this leg's risk, most important first.`;
  // Leg-chart position control: same `.ctl-label`-hosts-the-help rule as the leg picker above. Only
  // meaningful in leg mode, so it renders ONLY when a leg is selected. Options DERIVED from
  // LEG_CHART_POSITIONS (never a literal 1..9): a seat-count change to leg-top.js moves them.
  const posTitle = "Move the leg's own chart to this slot in the stack.";
  // The leg's own chart is OPT-IN by `deps.legSlot === true` (never /overview) AND a `LEG_CHART_ID`
  // entry — otherwise the members-only stack and no position control.
  const legChartId = deps.legSlot === true ? (LEG_CHART_ID[state.zoneD.legId] ?? null) : null;
  const legChart = !!legChartId;
  const posControl = state.zoneD.legId && legChart
    ? `<span class="ctl-label" title="${esc(posTitle)}">leg chart at</span>
    <select class="leg-chart-pos" aria-label="leg chart position">
      ${LEG_CHART_POSITIONS.map((p) => `<option value="${p}"${p === state.zoneD.legChartPos ? " selected" : ""}>${p}</option>`).join("")}
    </select>`
    : "";
  // Off-ladder legs (leg-top.js) append after the served sleeves in their own optgroup; they route
  // through the LEG_TOP config path (no weights needed) so they stay selectable while the model is cold.
  const legOpt = (k) => `<option value="${esc(k)}"${k === state.zoneD.legId ? " selected" : ""}>${esc(OFF_LADDER_LABEL[k] ?? sleeveLabel(k))}</option>`;
  const servedOpts = weights ? legKeys.map(legOpt).join("") : "";
  const offLadderGroup = `<optgroup label="Off-ladder">${OFF_LADDER_LEGS.map(legOpt).join("")}</optgroup>`;
  const coldNote = weights ? "" : `<span class="leg-note">ladder legs unavailable — the danger model hasn't loaded</span>`;
  const legPicker = `<div class="chart-controls leg-controls"><span class="ctl-label" title="${legTitle}">leg</span>
    <select class="leg-picker" aria-label="leg">
      <option value=""${state.zoneD.legId ? "" : " selected"}>— none —</option>
      ${servedOpts}${offLadderGroup}
    </select>${coldNote}${posControl}</div>`;
  // Compare slots (below the chart stack, so they add no height between charts).
  const comparePickers = `<div class="chart-controls compare-controls">${[0, 1]
    .map(
      (slot) => `<span class="ctl-label" title="Overlay a second chart to compare against.">compare ${slot + 1}</span>
    <select class="ind-picker-compare" data-slot="${slot}" aria-label="compare indicator ${slot + 1}">
      <option value=""${metas.some((m) => m.id === state.zoneD.compareIds[slot]) ? "" : " selected"}>— none —</option>
      ${optgroupsHtml(state.zoneD.compareIds[slot])}
    </select>`,
    )
    .join("")}</div>`;

  // Hoisted above the no-selection guard: with no indicator picked, a LEG pick still paints a
  // full stack — only a page with NEITHER selected has nothing to draw.
  const legPick = state.zoneD.legId ? deps.topIndicatorsFor(state.zoneD.legId, weights) : null;

  const chips = windowChipRow(state.zoneD.window ?? null);
  if (!meta && !legPick) {
    write(panel, `${picker}${legPicker}${chips}<p class="chart-msg">Pick an indicator.</p>`);
    return;
  }

  // A slow continuation must not paint over a newer indicator/leg pick (zoneD.legId).
  const token = deps.guardToken(state, ["zoneD.tab", "zoneD.indicatorId", "zoneD.legId", "zoneD.legChartPos", "zoneD.compareIds", "zoneD.window"]); // tab==="detail", indicatorId===meta?.id here

  // Chart stack. Leg mode: the leg's top-N rows take over the whole stack (no `primary` flag —
  // each chart carries its own name in the SVG head band); the indicator selection is preserved
  // but not charted, so clearing the leg restores the compare view. Otherwise: primary first,
  // then each SELECTED compare slot (empty or unknown-id slots render nothing). A leg member the
  // served meta list doesn't know renders a per-slot message — one dead row, not a dead stack.
  // Leg mode adds the leg's own indicator chart (`legChartId`, a plain member slot) at `legChartPos`
  // (placeLegChart clamps it); a member that IS that chart is dropped first, so none draws twice.
  const memberSlot = (id) => ({ kind: "indicator", meta: metas.find((m) => m.id === id) ?? null, id });
  const chartsIn = legPick
    ? legChart
      ? placeLegChart(legPick.ids.filter((id) => id !== legChartId), state.zoneD.legChartPos).map((slot) =>
          memberSlot(slot.kind === "leg" ? legChartId : slot.id),
        )
      : legPick.ids.map(memberSlot)
    : [
        { kind: "indicator", meta, primary: true },
        // A compare id absent from the served metas is DROPPED, not messaged: its picker has no
        // option for it and reads "— none —", so an Unknown row beside it would contradict the picker.
        ...state.zoneD.compareIds
          .map((id) => metas.find((m) => m.id === id))
          .filter(Boolean)
          .map((m) => ({ kind: "indicator", meta: m, id: m.id })),
      ];
  const win = state.zoneD.window ?? null;
  // Wrapped in a 1-tuple so a fetched-but-empty slot (`[null]`) stays distinct from a deferred one (`null`).
  const fetchSlot = (c) => Promise.all([c.meta ? fetchDetailSeries(c.meta, deps, win) : null]);
  // Lazy stack: with an `observe` dep, a leg stack's fetching slots paint a placeholder and fetch
  // on first intersect (seriesCache memoizes); no `observe` (/overview) or compare mode ⇒ eager.
  const lazy = !!legPick && typeof deps.observe === "function";
  const deferred = (c) => lazy && !!c.meta;
  const gen = (renderGen.get(state) ?? 0) + 1;
  renderGen.set(state, gen);
  const got = await Promise.all(chartsIn.map((c) => (deferred(c) ? null : fetchSlot(c))));
  if (!deps.isCurrent(state, token)) return; // selection moved on

  // Leg mode swaps the primary-only blurb for a CLOSED <details> basis/why block (leg-desc.js) —
  // no provenance line: the ranking's source is stated inside that block, not above the stack.
  const legDesc = legPick ? legDescBlock(state.zoneD.legId, metas) : "";
  const blurb = legPick ? "" : indicatorBlurb(meta, weights, metas); // explainer stays primary-only
  // `?mult` rides the shared getSeries envelope, so every chart's bands retune
  // identically — ONE panel-level badge above the stack covers all charts.
  const whatIf = whatIfBadge(got.find((g) => g?.[0]?.series)?.[0].series.mult);
  const stacked = chartsIn.length > 1;
  // Compare mode: legends split off each chart and re-slotted below the whole stack,
  // so the charts sit flush against each other. Returns `{ html, detail, legend }` (msg slots ⇒ null detail).
  const paintSlot = (c, k, f) => {
    const msg = (html) => ({ html, detail: null, legend: "" });
    if (!c.meta) return msg(`<p class="chart-msg">Unknown indicator "${esc(c.id)}" - not served right now.</p>`);
    const series = f?.series;
    const pts = series?.points ?? [];
    if (pts.length === 0)
      return msg(`<p class="chart-msg">No history yet for ${esc(c.meta.label)} - readings accrue daily.</p>`);
    // Compound-rule gates (F4's MA200 legs, F8's belowMA200) are now rendered by the
    // generic gate-aware chart itself (Case 4: dimmed/dashed segments + legend copy
    // from the spec's `gates`), so no per-id text note is appended here.
    // Carry the value-only flag (never-scored id ⇒ placeholder GREEN ribbon) onto the meta the
    // renderer sees, so the detail ribbon neutralizes (gray, or F7's z-severity) instead of calm.
    const r = detailChart(
      // `longLabel` comes off the /api/series payload (the registry's descriptive long name), not
      // off /api/indicators — the chart's accessible title renders "short — long (id)".
      // `unit` from /api/series: the same `indicator.unit ?? "%"` /api/indicators serves.
      { ...f.chartMeta, unit: series.unit, valueOnly: series.valueOnly, longLabel: series.longLabel },
      pts,
      // `scorerLegs`/`confirmCloses` ride the same envelope: the legend NAMES the live OR-legs and
      // the confirmation buffer from the server's own resolution, never from hardcoded copy.
      {
        effAmber: series.effAmber,
        effRed: series.effRed,
        scorerLegs: series.scorerLegs,
        confirmCloses: series.confirmCloses,
        legBounds: series.legBounds,
        // 2026-10-07: the served estimate tail of ANY id — built from the stored `estimated` rows (`estimateSlot`), no read-path nowcast.
        oasEst: series.oilEst, // E8: the wire serves no OAS estimate; the chart slot keeps its name
        // A held-fund leg's pre-join stand-in ({source, until}) — shaded + readout-tagged by detailChart.
        proxy: series.proxy,
      },
      // ≥1 compare slot filled ⇒ ALL charts (primary included) render the flush stack frame
      // (name + own dates in the SVG head band — no caption blocks, so the charts sit flush);
      // single-chart default stays byte-identical (geo undefined + window null = today's render).
      // R5: a licensed id arrives `redacted` (state-only points) ⇒ the ribbon-only frame.
      { geo: stacked ? STACK_CH : undefined, window: win, redacted: series.redacted === true },
    );
    const s = stacked ? splitLegend(r.svg) : { chart: r.svg, legend: "" };
    // Slot marker pairs the svg with its `details[k]` entry in the delegated scrub handler.
    // NOTHING is emitted after the svg: the full readout lives in the one viewport-pinned
    // `#hover-bar`, so stacked charts sit FLUSH (the per-chart `.hover-strip` that used to dock
    // here reserved ~55px each — ~275px of dead height on a 5-chart stack).
    return { html: s.chart.replace('<svg class="chart"', `<svg class="chart" data-chart-slot="${k}"`), detail: r.detail, legend: s.legend };
  };
  // Per-slot pointer-readout seams, aligned with the rendered stack (msg/placeholder slots ⇒ null).
  const details = [];
  const legends = [];
  const g = stacked ? STACK_CH : CH;
  const blocks = chartsIn.map((c, k) => {
    if (got[k] === null && deferred(c)) {
      details[k] = null;
      if (stacked) legends.push(`<div data-lazy-legend="${k}"></div>`);
      // Same viewBox as the chart it stands in for, so the row reserves its height before the fetch.
      return `<div data-lazy-slot="${k}"><svg class="chart-ph" viewBox="0 0 ${g.w} ${g.h}" width="100%" aria-hidden="true"></svg></div>`;
    }
    const p = paintSlot(c, k, got[k]?.[0]);
    details[k] = p.detail;
    if (stacked) legends.push(p.legend);
    return p.html;
  });
  const lazyWhatIf = !whatIf && chartsIn.some((c, k) => got[k] === null && deferred(c));
  // Leg mode omits the compare pickers (compare returns when the leg clears). The leg's own chart
  // always renders; a leg with no ranked members (cold model, or a leg no row reaches) says so
  // BELOW that chart instead of leaving the member slots empty.
  const noMembers = legPick && legPick.ids.length === 0 ? `<p class="chart-msg">No ranked indicators for this leg yet.</p>` : "";
  const stack = blocks.length
    ? blocks.join("") + noMembers
    : `<p class="chart-msg">No ranked indicators for this leg yet.</p>`;
  write(
    panel,
    `${picker}${legPicker}${chips}${whatIf}${lazyWhatIf ? "<div data-lazy-whatif></div>" : ""}${legDesc}${stack}${legends.join("")}${legPick ? "" : comparePickers + blurb}`,
  );
  deps.setState("zoneD", { details });
  if (!lazy) return;

  const host = (sel) => panel.querySelector(sel);
  let whatIfShown = !!whatIf;
  chartsIn.forEach((c, k) => {
    if (got[k] !== null || !deferred(c)) return;
    const el = host(`[data-lazy-slot="${k}"]`);
    let fired = false;
    deps.observe(el, async () => {
      if (fired) return;
      fired = true;
      const [f] = await fetchSlot(c);
      // A newer render (same selection included) or a moved selection owns the panel now.
      if (renderGen.get(state) !== gen || !deps.isCurrent(state, token)) return;
      const p = paintSlot(c, k, f);
      write(el, p.html);
      if (stacked && p.legend) write(host(`[data-lazy-legend="${k}"]`), p.legend);
      const mult = f?.series?.mult;
      if (!whatIfShown && mult > 0) {
        whatIfShown = true;
        write(host("[data-lazy-whatif]"), whatIfBadge(mult));
      }
      details[k] = p.detail;
      deps.setState("zoneD", { details });
    });
  });
}

/**
 * Per-meta detail fetch, both window modes. DATE-anchored (`chart.fromDays` — the aligned-start
 * ids): fetch from `anchor − PAD` so every such chart shares one calendar start regardless of
 * sampling/gaps, and inject `fromDate` (the anchor) for the renderer to slice at. COUNT
 * (everything else): visible `window` (default DETAIL_LIMIT) + `lead` leading buffer
 * (`meta.derived.window` or the spec's `lead`) — byte-equivalent to before for every count-window id.
 * `userWindow` (the zoneD.window chip) widens EITHER mode only when it exceeds DETAIL_LIMIT (the `5y`
 * chip); the narrower chips are draw-only slices of the default fetch. Returns `{ series, chartMeta }`.
 */
export async function fetchDetailSeries(meta, deps, userWindow = null) {
  const ext = expandingWindow(userWindow);
  // Standard level/velocity indicators opt the detail chart into the on-read recompute so the
  // ribbon re-tunes with the (shared/null-row) band lines; derived/bespoke charts (derived-kind
  // charts) are mode-invariant, so they keep the shared-state fetch (and its unfragmented
  // `id:limit` cache). The server independently ignores the flag for any indicator whose ribbon
  // can't diverge, so this is a display-side hint, not a contract. `displayOnly` derived blocks
  // (F1's lowRise) never score, so their ribbon IS recompute-aware — keep the detail fetch for
  // them (mirrors `supportsRecompute` in api/series.ts).
  const isDerived = meta.derived && meta.derived.kind !== "identity" && !meta.derived.displayOnly;
  const detail = !isDerived;
  const fromDays = meta.chart?.fromDays ?? null;
  if (fromDays != null) {
    // The expanding chip reaches its own span back…
    const fetchDays = Math.max(fromDays, Math.ceil((ext * 365) / 252));
    // …and moves the anchor with it, so the aligned-start ids still share one calendar start in 5y mode.
    const anchorISO = isoDaysAgo(fetchDays);
    // Floor the fetch `from` onto the /api/series month grid (P5) so the anchor-pad day never
    // 400s; the renderer still slices at the day-precise `fromDate` anchor below, so the coarser
    // fetch window is transparent — it only widens the leading buffer.
    // The pad also covers the spec's own `lead` (F1's toggle MA200 = 200 trading days ≈ 290 cal days); the
    // fixed pad alone left that line gapped over the left ~30% of the frame.
    const lead = Math.max(meta.derived?.window ?? 0, meta.chart?.lead ?? 0);
    const pad = Math.max(DETAIL_FROM_PAD_DAYS, Math.ceil((lead * 365) / 252) + DETAIL_FROM_PAD_DAYS);
    const series = await deps.fetchSeries(meta.id, DETAIL_MAX_LIMIT, detail, floorMonthStart(isoDaysAgo(fetchDays + pad)));
    return { series, chartMeta: { ...meta, chart: { ...meta.chart, fromDate: anchorISO } } };
  }
  const win = Math.max(meta.chart?.window ?? DETAIL_LIMIT, ext);
  // MAX, not `??`: an id can need BOTH lookbacks (F8/F4 — a 126-day derived return AND
  // the spec's 200-day MA overlay); the shorter one alone leaves the MA line a gap.
  const lead = Math.max(meta.derived?.window ?? 0, meta.chart?.lead ?? 0);
  return { series: await deps.fetchSeries(meta.id, win + lead, detail), chartMeta: meta };
}
