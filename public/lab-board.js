/**
 * /lab board region — family tiles, danger ledger (View A), structure map (View B),
 * rotation quadrant (View C), scoreboard, band-panel build + dial attribution.
 * Imported by lab.js; NEVER import lab.js from here (it runs module-level DOM side
 * effects at load — a cycle would execute them mid-import).
 */
import { esc } from "./chart-primitives.js";
import { API_TIMEOUT_MS, baseFetch, request } from "./http.js";
import { sleeveLabel } from "./sleeve-label.js";
import { posAttrs } from "./inline-pos.js";
import { hideHelp, setHTML } from "./help-bar.js";
import { createSheetPin } from "./viewport-pin.js";
import { tileEmptyCopy, tileMemberGroups, memberTone, TONE_CLASS, deadLitMarkHtml, dialLiveIdsOf } from "./tile-members.js";
import {
  attributionIndex,
  axisBadgeText,
  axisBadgeTitle,
  declinedNoteText,
  declinedNoteTitle,
} from "./leg-attribution.js";
import { MEMBER_HELP } from "./member-help.js";
import { legTitle, chipLabel } from "./leading-name.js";
import { scoreboardCardHtml } from "./scoreboard-card.js";
import { secTip } from "./section-tips.js";
import { reriskGateCopy } from "./rerisk-knobs.js";
import { SM_ROWS, SM_ROW_LABEL, SM_COLS } from "./structure-map-axes.js";
import {
  ABSENT_SEV,
  absentMark,
  foldOf,
  heldMark,
  legCellLagMark,
  legLagMark,
  memberSeverity,
  unmeasuredLagMark,
} from "./cell-observed.js";
import { cellTipHtml } from "./cell-tip.js";
import { feedLagFootHtml } from "./feed-lag-foot.js";
import { feedLagPanelShellHtml } from "./feed-lag-panel.js";
import { familyLagMarks, familyLagSlotHtml } from "./family-lag.js";
import { intradayMarkLabel, lastPrintLabel } from "./feed-age-mark.js";
import { coverageBadgeHtml, coverageIndex } from "./coverage-marks.js";
import { heldPathHtml, heldPathFootPhrase } from "./held-path.js";
import {
  BAND_CUTS,
  bandClass,
  setBandCuts,
  pillarValue,
  pillarBarHtml,
  bandTicks,
  BAR_FULL_SCALE,
  snSpeedArrow,
  ewSpeedArrow,
  exoGlyph,
} from "./sub-dangers.js";
import {
  MARKET_MODES,
  MARKET_MODE_GLYPHS,
  MODE_NA_GLYPH,
  marketMode,
  marketModeCellHtml,
  marketModeClass,
  marketModeQuadrantHtml,
} from "./market-mode.js";

const $ = (sel) => document.querySelector(sel);


/** The Mode column header's glyph→name legend, DERIVED from the ruled glyph map (single touch
 *  point: retune `MARKET_MODE_GLYPHS` and this user-visible tooltip follows). Key order of the
 *  frozen map is the ruled table's order. Pinned by `market-mode.test.js`. */
const MODE_ARROW_LEGEND = Object.entries(MARKET_MODE_GLYPHS)
  .map(([mode, glyph]) => `${glyph} ${mode}`)
  .join(" · ");
// Danger-ledger default footer (band read), recomputed each renderDangerField so applyBoard
// can restore it after an R4-breaker override.
export let dfFootDefault = "";
// Danger-ledger interactive sub-state (lifted out of the once-frozen grid): the "+ region/sector"
// reveal and the held-row attribution expand. renderDangerField re-applies both as grid classes
// each render so a rebuild preserves open state; delegated listeners on the stable #dangerField
// mutate them (wired once in buildDangerField).
let dfShowRgn = false;
let dfShowAttrib = false;
// Last resolved field + d, cached each applyBoard (the quadrant re-renders from these on a
// momentum dot-click without a refetch).
let lastField = null;
let lastD = null;
// Scenario-only manual per-leg momentum input (sleeve → −1 | 0 | +1). Reset to {} on entering
// scenario (see setMode/fetchScenario). Live mode ignores this and uses server l.momentum.
let scnMomentum = {};
// The STATIC danger-model reference block (`/api/danger-model` — the SignalKey↔FamilyKey
// bijection, the per-member relevance mask, member labels, and the concentration/deadband
// knobs). Fetched ONCE and cached module-level: the signal-grid columns, decorateCell, the
// concentration badge + the knobs footer all read it. Kicked off in parallel with the first
// board fetch (loadDangerModel is idempotent); fails soft to null so the grid degrades rather
// than crashing if the endpoint is unreachable. Only a SUCCESS is cached: a network error or
// non-ok response drops the cached promise, so the next call (a refocus repaint) retries.
export let dangerModel = null;
let dangerModelReady = null;
// lab.js passes `fetchOnce` (takes the boot prefetch); public/load-cycle.test.js injects stubs.
export function loadDangerModel(fetchImpl = baseFetch) {
  if (!dangerModelReady) {
    dangerModelReady = request("/api/danger-model", { fetchImpl, timeoutMs: API_TIMEOUT_MS })
      .then((r) => {
        if (!r.ok) throw new Error(`/api/danger-model ${r.status}`);
        return r.json();
      })
      .then((m) => {
        dangerModel = m;
        // Adopt the server-sent leg-RAG cuts so the ledger idiom colours agree with the server
        // (and a USER retune propagates); a null payload keeps sub-dangers.js's matching default.
        if (m && m.legRagCuts) setBandCuts(m.legRagCuts);
      })
      .catch(() => {
        dangerModel = null;
        dangerModelReady = null;
      });
  }
  return dangerModelReady;
}
/** Family tiles — built once; classes/state text updated in place by applyBoard.
 *  Tiles read d.globalFamilies, NOT the legacy US d.families.
 *  d.globalFamilies is the DISPLAY panel: the dial folds against the narrower
 *  DIAL_FAMILIES (GLOBAL minus the display-only SLOW legs), so the board is a
 *  superset of the dial by exactly those legs and can show one RED the dial ignores.
 *  Tiles pack densely and each tile carries its lead-time SUPER-GROUP inline as a dimmed
 *  micro-label after the family name (family→group map = dangerModel.superGroupOf ∘ signalOf,
 *  served; family ORDER = d.globalFamilies, served). Degrades to no group label when the
 *  danger-model block is absent or predates superGroupOf.
 *  Every served member renders — the 4 SLOW
 *  volatility legs paint too, sectioned "bubble watch" by `tileMemberGroups`. DB_SMH stays
 *  off tiles: its cell lives in the BAND `ew` row (band-panel.js).
 *  `tilesEl` is the `#tiles` container to write into — defaulted to the document lookup; the
 *  families-board seam passes its own host's, so a test hands in a stub instead of a global. */
export function buildTiles(d, tilesEl = $("#tiles")) {
  const m = dangerModel || {};
  const groupOf = (m.signalOf && m.superGroupOf) ? (key) => m.superGroupOf[m.signalOf[key]] : () => undefined;
  const attrs = attributionIndex(d);
  const flips = coverageIndex(d);
  // Feed-lag roll-up: ONE pure join per payload,
  // rendered through the same `familyLagSlotHtml` producer the applyBoard refresh calls. Labels
  // come from `dangerModel.memberLabel` — the SAME map `feedLagFoot` passes to the ledger footnote,
  // so the two surfaces can never name the same feed differently. Display-only: it arms nothing.
  const lagMarks = famLagMarks(d);
  // D3 served weighted-id set (empty on an old cached payload ⇒ every member paints `live`).
  const legWeighted = new Set((d.dangerRoster && d.dangerRoster.legWeightedIds) || []);
  const perLegOnly = new Set((d.dangerRoster && d.dangerRoster.perLegOnlyIds) || []);
  // Served fold roster (`pillarIds`); absent on an old payload ⇒ `undefined`, so no chip is marked dead-lit.
  const pillar = d.dangerRoster && d.dangerRoster.pillarIds ? new Set(d.dangerRoster.pillarIds) : undefined;
  const dialLive = dialLiveIdsOf(d);
  const tilesHtml = d.globalFamilies
    .map((f) => {
      // Per-leg state: firing legs (AMBER/RED) render a coloured
      // name + leading glyph; calm (GREEN) legs stay dim & bare — so the tile makes the
      // *cause* of a family's amber/red visible at a glance (e.g. flight AMBER → FXH).
      const members = f.members || [];
      // A deliberately-feedless family renders its `awaiting` reason
      // instead of the generic "no live feed" — resolved by the pure tileEmptyCopy seam.
      const legHtml = legStripHtml(f, members, attrs, flips, legWeighted, perLegOnly, pillar, dialLive);
      const title = f.desc ? ` title="${esc(f.desc)}"` : "";
      const g = groupOf(f.key);
      const groupHtml = g ? `<span class="t-g">${esc(g)}</span>` : "";
      // data-awaiting makes the stub state inspectable without parsing rendered text.
      const awaitingAttr = f.awaiting ? ` data-awaiting="${esc(f.awaiting)}"` : "";
      return `
      <div class="tile s" data-key="${esc(f.key)}"${awaitingAttr}>
        <div class="t-h"${title}><i class="dot s"></i><b>${esc(f.label)}</b>${groupHtml}<span class="t-lag">${familyLagSlotHtml(lagMarks, f.key)}</span><span class="st"></span><span class="t-cannot"></span></div>
        <div class="t-diff"></div>
        <div class="ids">${legHtml}</div>
      </div>`;
    })
    .join("");
  setHTML(tilesEl, tilesHtml);
}

/** The board's feed-lag join, derived ONCE per payload and fed to `familyLagSlotHtml` (per tile)
 *  and `orphanLagSlotHtml` (board head). Both paint paths — buildTiles and the applyBoard refresh —
 *  call THIS, so the two can never disagree about which feeds are behind.
 *
 *  `dangerModel.memberLabel` is the same id→label map `feedLagFoot` hands the ledger footnote
 *  (Rule 2: a registry id never renders bare). It is null until /api/danger-model resolves; the seam
 *  then falls back to the bare id rather than dropping the mark — a mark is the point, the name is
 *  the polish. Degrades to no marks on a payload without `feedLag` (scenario/replay), which is what
 *  the footnote does too. */
export function famLagMarks(d) {
  return familyLagMarks(
    (d && d.globalFamilies) || [],
    (d && d.feedLag) || [],
    (dangerModel && dangerModel.memberLabel) || {},
  );
}

/** The tile's member-chip strip — the ONE producer both paint paths (buildTiles + the applyBoard
 *  refresh) call, so a strip change can never paint once and vanish on the first board update.
 *
 *  Flat row of `legSpan` chips, EXCEPT where `tileMemberGroups` returns role groups (trend: band +
 *  depth / band-driving / per-leg only; credit/rates: band-driving / per-leg only (served `perLegOnlyIds`) / per-leg; volatility: band-driving vs bubble watch). Grouping is DISPLAY-ONLY — same chips, same
 *  order, same `data-id`s, so the per-leg click/aria wiring below is untouched by it. An empty
 *  member list still renders the awaiting/no-feed stub. */
export function legStripHtml(f, members, attrs, flips, legWeightedIds, perLegOnlyIds, pillarIds, dialLiveIds) {
  if (!members.length) return `<span class="leg-calm">${esc(tileEmptyCopy(f))}</span>`;
  // D3 tone: `live` if the member sits on the served band ids (moves the band), else `dead` (outside the served
  // `pillarIds`) / `per-leg` / `leg-only` / `grey` off the SERVED sets. A payload without either falls back to the full roster / empty set,
  // so an old cached response paints every present member `live` rather than mis-dimming one. A member outside
  // `pillarIds` stays `live` only while it also seats the served DIAL band (`dialLiveIds`, see `memberTone`).
  const bandIds = (f && f.band && f.band.ids) || (f && f.ids) || [];
  const chip = (m) => {
    const tone = memberTone(m.id, bandIds, legWeightedIds, perLegOnlyIds, pillarIds, dialLiveIds);
    return legSpan(m, attrs, flips, TONE_CLASS[tone]) + deadLitMarkHtml(m.id, tone, pillarIds);
  };
  const groups = tileMemberGroups(f, members, perLegOnlyIds);
  if (!groups) return members.map(chip).join(" ");
  return groups
    .map(
      (g) =>
        `<span class="lg" data-group="${esc(g.key)}"><span class="lg-l" title="${esc(g.title)}">${esc(g.label)}</span>` +
        `${g.members.map(chip).join(" ")}</span>`,
    )
    .join("");
}

/** One board-tile leg, 4-level glyph: a firing member renders a
 *  leading state glyph + coloured name — RED `●` / AMBER `◐`; a calm (GREEN) member
 *  renders `○` (not bare) so board tiles and the danger-field signal grid read in ONE
 *  glyph language (design §2.2 · `·` n/a · `○` calm · `◐` elevated · `●` lit). Non-scored
 *  context legs are the `·`/grey group in buildTiles (they never reach here). */
/*  A firing DUAL-AXIS member also carries a "via velocity" / "via level" badge
 *  naming which axis attributed today's confirmed state. `attrs` is the id-indexed
 *  `legAttribution` block (live only, empty on scenario/replay); ids the server did not
 *  attribute — R2/R3/R4 among them, which it structurally never emits — render as before.
 *  An entry carrying a `declined` reason instead of an axis renders a muted
 *  note in the badge slot, so a firing the server could not attribute no longer paints
 *  identically to a calm one. Exactly one of the two ever shows (the wire guarantees exactly
 *  one of `leg`+`axis` / `declined`). */
/*  Coverage: a member that is NOT LIVE (lagging past its own cut, or absent) while
 *  its family's verdict rests on it carries the `⊗` COVERAGE badge (`coverage-marks.js`), so a
 *  verdict held up by data we cannot see no longer paints identically to a live one. It is NOT a
 *  lag mark — `◌`/`⌁` mean "behind but still counted" and live in the ledger's Lag column; `⊗`
 *  means dark AND arming the coverage floor (band capped at WATCH). Independent of the
 *  axis/declined badge above: both can ride the same chip. */
function legSpan(m, attrs, flips, toneCls) {
  // Two axes on one chip: state colour (leg-r/-a/-calm) + D3 tone (mt-live/-perleg/-leg/-grey/-dead) — the
  // tone dims by how little of the dial a member moves, orthogonal to its own severity.
  const cls = (m.state === "RED" ? "leg-r" : m.state === "AMBER" ? "leg-a" : "leg-calm") + (toneCls ? " " + toneCls : "");
  // Hover copy: the member's own SHORT name (`label`) once, then the hand-written help
  // sentence appended raw (the BARE sentence, no leading "<label> — " clause).
  // The descriptive `longLabel` still ships on the wire but does not render here.
  // B5 (R9) / L3, moved 2026-09-30: an INTRADAY / EST row no longer paints a visible marker on the tile —
  // the chip colour already follows the served intraday state, and the clause rides the chip's own
  // tooltip instead (user ruling: no markers on the families board).
  const intra = intradayMarkLabel(m, m.obs);
  // E22: `last print D-n` rides the same tooltip (no visible board marker, as above).
  const lp = lastPrintLabel(m.lastPrint);
  const help = legTitle(m.label, [MEMBER_HELP[m.id], intra && intra.title, lp && lp.title].filter(Boolean).join(" · "));
  // The CHIP text is the label as one compact token (`chipLabel`),
  // NOT the raw id (Rule 2: a registry id never renders bare). `data-id` keeps the raw id so the
  // per-leg click handlers still key off it. A member with no label degrades to its id (no spaces).
  const title = help ? ` title="${esc(help)}"` : "";
  const attr = (attrs || {})[m.id];
  const badgeText = axisBadgeText(attr);
  const declinedText = badgeText ? "" : declinedNoteText(attr);
  let badge = "";
  if (badgeText) {
    badge = ` <span class="leg-axis" data-axis="${esc(attr.axis)}" title="${esc(axisBadgeTitle(attr))}">${esc(badgeText)}</span>`;
  } else if (attr && declinedText) {
    badge = ` <span class="leg-declined" data-declined="${esc(attr.declined)}" title="${esc(declinedNoteTitle(attr))}">${esc(declinedText)}</span>`;
  }
  const flipBadge = coverageBadgeHtml((flips || {})[m.id], m.label);
  // Word badge reading `held` when the member is mid directional-fold stand-down (`foldOf`); the full
  // clause rides `title=`, `of` interpolated from the SERVER payload, never an FE literal.
  const fold = foldOf(m);
  const heldBadge = fold
    ? ` <span class="leg-held" title="${esc(`held - raw ${fold.raw}, stands down after ${fold.of} clean closes`)}">held</span>`
    : "";
  return `<span class="${cls}" data-id="${esc(m.id)}"${title}>${esc(chipLabel(m.label || m.id))}</span>${flipBadge}${badge}${heldBadge}`;
}
/* ===================================================== VIEW A — DANGER FIELD
 * Renders design-doc §3 View A: a per-leg danger ledger + full 9-leg signal grid + the
 * held ▶ "read" + a dial-band footer, as REAL /lab production code (not a mockup).
 *
 * Data seams: the danger engine lives ONLY in src/danger-engine.ts; the server ships
 * `d.field.legRows` carrying the per-leg PROPERTY model (region/exposure/sector/style, risk rank —
 * design §2.1) + the DERIVED `danger` (share-lit: max of pillars, trend, capped gp). The FE keeps ONLY the render substrate
 * (decorateCell + buildMemberState) to rebuild cell tooltips. Membership, the relevance mask, member
 * labels + the concentration/deadband knobs are not mirrored client-side: family
 * membership reads the LIVE `d.globalFamilies` panel, and the relevance mask / member labels /
 * knobs come from the once-fetched `/api/danger-model` block (cached in `dangerModel`). The signal
 * grid is DERIVED (design §10): each leg×family cell rolls up that family's member indicators —
 *  · MEMBER_STATE is sourced LIVE from the board (d.globalFamilies → the same states legSpan
 *    renders on the tiles), so the grid can never contradict the live board (§10.7);
 *  · family membership = the served d.globalFamilies panel's member-id lists;
 *  · relevance = the served dangerModel.memberRelevance mask (§10.4) — the `·`/n-a cells fall out
 *    of it (N=0).
 * cellState = worst live state among a leg's RELEVANT members; the M/N firing drill-down +
 * per-member breakdown live in the glyph's own title tooltip (§10.5).
 *
 * Encoding discipline (design §4): colour intensity encodes the DANGER score in the ledger
 * bar; RGN/SECTOR are letter/short codes, never hue; the signal glyphs (· ○ ◐ ●) carry
 * ORDINAL severity hue (calm/elev/lit, aligned with the danger axis — §4 KEEPS severity
 * hue), which is NOT the banned categorical hue; identical layout across 9. */
// 5-level signal glyph — presence, not hue (design §4). Same language as board legSpan.
// `absent` is the member that did NOT report, distinct from `na` (not relevant to
// this sleeve) and from `calm` (reported, and reported quiet).
const SIG_GLYPH = {
  na: { g: "·", cls: "sg-na" },
  absent: { g: "∅", cls: "sg-absent" },
  calm: { g: "○", cls: "sg-calm" },
  elev: { g: "◐", cls: "sg-elev" },
  lit: { g: "●", cls: "sg-lit" },
};
/** A member indicator's live severity for the signal grid, mapped exactly as board legSpan
 *  reads m.state (RED→lit, AMBER→elev, else GREEN→calm). Sourced from d.globalFamilies so the
 *  grid and the board tiles read one language (§10.7).
 *
 *  Server parity: severityOf returns null for a member that never reported and the server
 *  OMITS THE KEY — an unobserved member is
 *  ABSENT here too — no key — and `decorateCell` renders it as `absent`, never as calm. The
 *  mapping itself lives in the pure seam (`cell-observed.js`, `memberSeverity`) where it is pinned
 *  against the real server builder. */
function buildMemberState(d) {
  const st = {};
  for (const f of d.globalFamilies || []) {
    for (const m of f.members || []) {
      const sev = memberSeverity(m.state);
      if (sev === null) continue; // unobserved ⇒ ABSENT (no key), never calm — server parity
      st[m.id] = sev;
    }
  }
  return st;
}

/** The member map THE CELLS WERE BUILT FROM — a DIFFERENT VINTAGE from `buildMemberState` above, and
 *  the two must not be collapsed into one reader.
 *
 *  `field.memberState` is the held map `computeCells` folded
 *  (`FieldResult.memberState`, src/danger-engine.ts); `buildMemberState` is the plain per-close family
 *  panel. Re-deriving the signal-cell drill-down from the PANEL is what put `2/8 firing` above eight
 *  calm chips on /lab: `M` counted two members the hold window had raised, and the chips read their
 *  live GREEN. Anything printing per-member state BESIDE a cell's M/N/wsev/census reads THIS.
 *
 *  ⚠ AND NOTHING ELSE DOES. A LIVE-WEATHER read — `exoGlyph`'s G1, whose whole contract is "the
 *  confirmed state as of this close" — must keep reading `buildMemberState`: the hold would let it
 *  assert a red oil shock off a reading up to `SIGNAL_HOLD_CLOSES` old, and the lead gate would delete the
 *  member entirely, which `exoGlyph` renders as "the feed did not report". Both are claims the live
 *  panel does not make.
 *
 *  Falls back to the panel fold for a pre-`field.memberState` cached response only — that reproduces
 *  the old, disagreeing vintage, which beats an empty drill-down but is NOT what the cell was built
 *  from. */
function buildCellMemberState(d) {
  const served = d.field && d.field.memberState;
  if (!served || typeof served !== "object") {
    // Panel-fold fallback carries no hold provenance — every entry reads unheld, never a fabricated one.
    const st = {};
    for (const [id, sev] of Object.entries(buildMemberState(d))) st[id] = { sev, held: false, heldAge: null };
    return st;
  }
  const st = {};
  for (const [id, obs] of Object.entries(served)) {
    // Absent stays ABSENT: the server omits the key, and so do we — never `?? "calm"`.
    if (obs && typeof obs === "object" && typeof obs.sev === "string")
      st[id] = {
        sev: obs.sev,
        held: obs.held === true,
        heldAge: typeof obs.heldAge === "number" ? obs.heldAge : null,
      };
  }
  return st;
}

/** Danger band for the colour ramp — the ONLY thing hue encodes in the ledger (design §4).
 *  The threshold seam now lives in the DOM-free sub-dangers.js island (shared with the two-pillar
 *  idiom helpers + their tests); this alias keeps the structure-map / quadrant call sites. */
const dangerClass = bandClass;

/** Decorate a served signal cell (`{family, cellState, M, N, wsev, observed}` — the shape the
 *  server ships on `d.field.legRows[].cells`) with the FE-only render fields (glyph/cls/title) the
 *  BE omits (i7a render-flip). Rebuilds the M/N drill-down title from the SERVED danger-model
 *  (`dangerModel.memberRelevance` mask + `dangerModel.memberLabel`) + live memberState.
 *  `cell.family` is the 2-letter SignalKey — mapped to the long FamilyKey via the served
 *  bijection so the family's member ids can be read off the LIVE `membersByFamily` panel.
 *  Retains `family` on the output so renderDangerField can order columns by served family.
 *
 *  Also carries the cell's OBSERVATION census (`cell.observed`) into
 *  the tooltip and — when ≥1 relevant member is absent — a visible `mk` superscript count plus the
 *  `sig-absent` class on the cell, so a calm-looking `○` built on a dead feed is distinguishable
 *  from a measured calm. DISPLAY ONLY: nothing here reaches the band, the pick, or notify. */
function decorateCell(cell, leg, memberState, membersByFamily, foldByMember, unstamped, served) {
  const fam = cell.family; // 2-letter SignalKey (cr/uT/…)
  const gl = SIG_GLYPH[cell.cellState] || SIG_GLYPH.na;
  const model = served || {};
  const famKey = (model.familyOfSignal || {})[fam]; // → long FamilyKey (credit/trend/…)
  const memberIds = (famKey && membersByFamily[famKey]) || [];
  const relevance = model.memberRelevance || {};
  const labels = model.memberLabel || {};
  const weights = model.memberWeight || {};
  const relevant = memberIds.filter((m) => (relevance[m] || []).includes(leg.sleeve));
  // The `×<weight>` magnitude suffix.
  // Weight = MEMBER_WEIGHT[member][sleeve] — how hard this member hits THIS leg — which
  // is what makes "2/5 firing" readable: two ×1.0 members is not two ×0.4 members. Omitted (not
  // printed as ×—) when the served model is missing or predates the field, so an older cached
  // /api/danger-model degrades to the weightless tooltip rather than to noise.
  const memStates = relevant.map((m) => {
    const o = memberState[m];
    return {
      id: m,
      // OQ-5 Stage 5.4: no key ⇒ the member never reported ⇒ `absent`, NOT an imputed calm.
      state: o ? o.sev : ABSENT_SEV,
      // Per-member hold provenance (`MemberObservation.held`) — independent of the cell's argmax
      // `held` mark, so a held member out-weighed by a live one still reads held in its own row.
      held: o && o.held ? { ageCloses: o.heldAge } : null,
      w: (weights[m] || {})[leg.sleeve],
      // Per-member directional-fold mark off the LIVE panel (`foldByMember`), not the danger
      // field's member map — the fold lives only on `d.globalFamilies`. Normalised via `foldOf`.
      fold: (foldByMember || {})[m] || null,
    };
  });
  // The drill-down is a PANEL, not a `title=` line. The naming/weight rules live
  // in `cellTipHtml` (the pure seam); this call site only supplies the joined roster.
  // ⚠ NO `title=` ON THE CELL, deliberately: a native tooltip would race the panel,
  // and `decorateHelp` would inject a ⓘ into the very element the panel hangs off
  // ([USER]: no new glyphs — the tooltip rides the existing cell).
  const tip = cellTipHtml(
    cell,
    memStates.map((x) => ({ id: x.id, label: labels[x.id], sev: x.state, held: x.held, w: x.w, fold: x.fold })),
    // The drill-down census reads the SAME `observed` the `Lag` column does, so it owes the
    // same gate: without a stamp its fresh/lag split is `obsOf`'s default, not a measurement.
    unstamped,
    // Names the census footer's served `absentIds` — the engine-roster members behind the absent
    // count, which the panel roster above may not even list.
    labels,
  );
  const mark = absentMark(cell);
  // The cell's severity may come from the HOLD WINDOW rather than from today's reading, which
  // is why a cell can read `elev` with every one of its family chips green. Class only: the member, the
  // AGE of the severity shown and the window it cannot outlive ride the drill-down panel's `ct-held` row
  // (`cellTipHtml`, above), and the `<sup>` stays the absent count alone.
  const held = heldMark(cell);
  // The feed-lag `◌` does not ride in the signal cell: it is diagnostics,
  // not operational signal, and lives with `⌁` in the rightmost `Lag` column (`legCellLagMark`).
  // The absent-count superscript stays — it quantifies the cell's OWN severity max, not a feed.
  return {
    family: fam,
    cellState: cell.cellState,
    cls: gl.cls + (mark ? ` ${mark.cls}` : "") + (held ? ` ${held.cls}` : ""),
    g: gl.g,
    mk: mark ? mark.html : "",
    tip,
  };
}

/** Resolve the danger field for the three render sites. The danger engine is server-only
 *  (src/danger-engine.ts): read `d.field` — danger/band/held computed off the LIVE dial
 *  band and fully scenario-responsive via the existing /api/lab refetch — and decorate its
 *  reduced cells FE-side (rebuild glyph/cls/title from the retained relevance mask). `field` is
 *  non-optional on LabResponse, so d.field is always present; the guard degrades to an empty
 *  field (never crashes) only if a stale cached response is served mid-deploy.
 *  `held` may be `null` (server returns null on an empty band) — callers guard it. */
export function resolveField(d, model = dangerModel) {
  if (!d.field) return { legRows: [], band: null, held: null };
  const memberState = buildCellMemberState(d);
  // Family → member-id list off the LIVE panel;
  // keyed by the long FamilyKey, which decorateCell maps to from cell.family via the bijection.
  const membersByFamily = {};
  // `absentIds` (the family's dark roster ids) join the present members: the drill-down roster
  // must include the member an absent census count refers to (a member once counted `1 absent` on
  // the vl cell while missing from the panel entirely). decorateCell's relevance
  // filter still scopes them per leg; memberState has no entry for them ⇒ they render `∅ absent`.
  for (const f of d.globalFamilies || [])
    membersByFamily[f.key] = [...(f.members || []).map((m) => m.id), ...(f.absentIds || [])];
  // id → normalised `fold` off the LIVE panel — the SAME `foldOf` the chip badge reads, so a
  // malformed mark degrades to null identically. The danger field's member map carries no `fold`.
  const foldByMember = {};
  for (const f of d.globalFamilies || [])
    for (const m of f.members || []) foldByMember[m.id] = foldOf(m);
  // `freshnessMissing` — THE STAMP IS ABSENT, so `observed.lag` on every cell is `obsOf`'s
  // unmeasured default, not a measurement. Firing the column off it painted `⌁◌⁶` on prod with an
  // EMPTY `feedLag` footnote. See `unmeasuredLagMark` for the measurement and the rule.
  const unstamped = d.freshnessMissing === true;
  const legRows = d.field.legRows.map((l) => ({
    ...l,
    // The per-leg feed-lag roll-up, computed in the pure seam over the RAW served cells
    // (they still carry `observed`; the decorated ones below do not) so there is exactly ONE
    // census-reading path. `null` when no cell of the leg fires.
    lagMark: unstamped ? unmeasuredLagMark() : legLagMark(l.cells),
    // The `◌` half of the same column, rolled up over the same RAW cells for the same
    // reason (exactly one census-reading path; the decorated cells below have dropped `observed`).
    // Suppressed with no stamp: the COUNT is the false claim (`◌⁶`), and the `—` above already says
    // the honest thing once.
    cellLagMark: unstamped ? null : legCellLagMark(l.cells),
    cells: l.cells.map((c) => decorateCell(c, l, memberState, membersByFamily, foldByMember, unstamped, model)),
  }));
  return { legRows, band: d.field.band, held: d.field.held };
}

/** Once, in buildBench: wire the danger-ledger's persistent listeners via event delegation on
 *  the stable #dangerField wrapper (which survives inner-grid rebuilds), so re-rendered grid
 *  content never loses or duplicates handlers. Open/closed state lives in dfShowRgn/dfShowAttrib
 *  module vars; renderDangerField re-applies them as grid classes each render. */
/** Signal-cell drill-down markup by `${sleeve}|${family}`, refilled by every renderDangerField.
 *  Held OUT of the grid markup so only the open panel's rows exist in the DOM (see the render site).
 *  `clear()` on each rebuild is what stops a retired cell's panel outliving its cell. */
const cellTips = new Map();

/** Closes the open drill-down panel, if one is open. Assigned by `wireCellTip`; a no-op until the
 *  bench is built. `renderDangerField` calls it BEFORE refilling `cellTips`: the panel's markup is a
 *  snapshot of the previous fold, and leaving it up over freshly rendered cells would show a stale
 *  census beside a cell that has since moved or changed state. */
let closeCellTip = () => {};

/** Place the open panel beside its cell. `position: fixed` off the cell's viewport rect — NOT an
 *  absolutely-positioned child — because the grid scrolls horizontally inside `.df-grid-wrap`, so a
 *  child panel would be clipped by the very overflow that makes the right-hand signal columns
 *  reachable. Clamped to the viewport on both axes, and flipped above the cell when it would run off
 *  the bottom, so a cell on the last leg row still shows a whole panel. */
function placeCellTip(panel, cell) {
  const r = cell.getBoundingClientRect();
  panel.style.left = "0px";
  panel.style.top = "0px";
  const p = panel.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(r.left, window.innerWidth - p.width - margin));
  const below = r.bottom + margin;
  const top = below + p.height > window.innerHeight - margin ? Math.max(margin, r.top - p.height - margin) : below;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

/** Open/close the one drill-down panel. ONE element for the whole grid, appended to `#dangerField`.
 *
 *  ⚠ WRITTEN THROUGH `setHTML`, like every other title-capable write in this file (write-seam.test.js).
 *  The panel's own markup carries no `[title]` by construction (`cell-tip.js`), so no ⓘ is injected —
 *  but routing it through the seam keeps that a property of the markup rather than of this call site.
 *
 *  Hover opens it on a mouse; tap/click and keyboard focus open it on touch — the SAME element either
 *  way, which is what makes the drill-down reachable on mobile without a second surface. */
function wireCellTip(field) {
  const panel = document.createElement("div");
  panel.className = "cell-tip";
  panel.hidden = true;
  field.appendChild(panel);
  // ≤640px the panel is a `bottom: 0` sheet (lab.css); pinch-zoom would push it below the
  // visible fold, so pin it to the visual viewport WHILE the sheet is showing. Only ever
  // touched on the mobile path — on desktop the panel is a floating box `placeCellTip` positions,
  // and this controller's `hide()` is a no-op until a `show()` has run, so it never clears that.
  const cellPin = createSheetPin(panel);
  let openKey = null;
  // PINNED = the reader clicked/tapped, so the panel is interactive and hover no longer replaces it.
  // ⚠ THIS IS WHAT MAKES THE FOLD REACHABLE WITH A MOUSE. While merely hovering, the panel is
  // `pointer-events: none` and sits below the cell — so the pointer travelling toward it crosses the
  // NEXT leg row's signal cell, whose `pointerover` would swap the panel out from under the cursor.
  // A hover panel you cannot reach is a hover panel whose `+N not firing ▸` weights are unreadable on
  // a desktop, which is where they were asked for. Hover previews; a click pins.
  let pinned = false;
  // Timestamp of the last open() — the opening tap ITSELF scrolls (the cell's `tabindex="0"`
  // focus-scroll + the mobile URL-bar shift) AND delivers a `click` after its `focusin`, so both
  // scroll-close and the second-tap toggle must ignore this grace window.
  let openedAt = 0;
  const openGraceMs = 300;
  const close = () => {
    panel.hidden = true;
    panel.classList.remove("pinned");
    openKey = null;
    pinned = false;
    cellPin.hide(); // detach visual-viewport listeners + clear the pinned top (no-op on desktop)
  };
  closeCellTip = close;
  const open = (cell) => {
    const key = cell.getAttribute("data-tip");
    // Mobile only: on desktop the floating panel and bottom bar never overlap, and hover/Tab route
    // through open() — an unconditional hideHelp would let a mere mouse-across kill the bar.
    const mobile = window.matchMedia("(max-width: 640px)").matches;
    // Already showing this cell: DO NOTHING but re-assert the sheet invariant below. `pointerover`
    // bubbles from every child transition (glyph → the absent-count `<sup>`), and re-running setHTML
    // would rebuild the panel from `cellTips` — silently collapsing a fold the reader had just
    // expanded. The hideHelp still runs: the opening tap's own capture-phase
    // carve-out click (the held row's `<tr title>`) re-shows the bar AFTER `focusin` opened us.
    if (key && openKey === key && !panel.hidden) return void (mobile && hideHelp());
    const html = key && cellTips.get(key);
    if (!html) return close();
    openKey = key;
    setHTML(panel, html);
    panel.hidden = false;
    // RULED: on MOBILE opening this z-60 sheet closes the z-50 help bar — never two
    // sheets stacked with the lower one invisible (a titled ledger cell tap opens both otherwise).
    if (mobile) hideHelp();
    placeCellTip(panel, cell);
    // Mobile: it is a bottom sheet — pin it to the visual viewport (over placeCellTip's left/top,
    // which the mobile `inset … !important` rule already overrides). Desktop keeps the floating box.
    if (mobile) cellPin.show();
    openedAt = Date.now();
  };
  // Hover (mouse only — a touch `pointerenter` fires on tap and would double-handle the click below).
  field.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || pinned) return;
    const cell = e.target.closest("td.sig[data-tip]");
    if (cell) open(cell);
    else if (!e.target.closest(".cell-tip")) close();
  });
  field.addEventListener("pointerleave", () => {
    if (!pinned) close();
  });
  // Tap / click. A click INSIDE the panel is the fold button's — leave it to its own handler.
  field.addEventListener("click", (e) => {
    if (e.target.closest(".cell-tip")) return;
    const cell = e.target.closest("td.sig[data-tip]");
    if (!cell) return;
    // Second tap on the same cell closes — on touch there is no pointerleave to do it. Grace-gated:
    // the OPENING tap's own click (arriving right after its `focusin` pinned the panel) is not a
    // second tap.
    if (pinned && openKey === cell.getAttribute("data-tip") && !panel.hidden && Date.now() - openedAt >= openGraceMs)
      return close();
    open(cell);
    pinned = true;
    panel.classList.add("pinned");
  });
  // Keyboard: focusing a cell opens its panel PINNED — the `tabindex="0"` on the cell is what makes
  // the drill-down reachable without a pointer, and without this handler it was ~70 dead tab stops
  // beside an Escape handler that closed a panel the keyboard could not open.
  field.addEventListener("focusin", (e) => {
    const cell = e.target.closest("td.sig[data-tip]");
    if (!cell) return;
    open(cell);
    pinned = true;
    panel.classList.add("pinned");
  });
  // The fold, inside the panel. Same idiom as the band panel's `.bp-fold`.
  panel.addEventListener("click", (e) => {
    const btn = e.target.closest(".ct-fold");
    if (!btn) return;
    const list = panel.querySelector(".ct-folded");
    if (!list) return;
    const openNow = list.hidden;
    list.hidden = !openNow;
    btn.setAttribute("aria-expanded", String(openNow));
    btn.textContent = btn.textContent.replace(openNow ? "▸" : "▾", openNow ? "▾" : "▸");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // `placeCellTip` captures the cell's VIEWPORT rect, so any scroll or resize detaches the panel from
  // the cell it describes — including a horizontal scroll inside `.df-grid-wrap`, which fires no
  // pointer event while the cursor rests on the panel. Close rather than re-place: a drill-down whose
  // subject has moved is stale, not merely mispositioned. Two exemptions: the ≤640px bottom sheet is
  // viewport-fixed (scroll cannot detach it; renderDangerField already closes on stale content), and
  // scrolls inside the post-open grace window are the opening tap's own (see `openedAt`).
  window.addEventListener(
    "scroll",
    () => {
      if (Date.now() - openedAt < openGraceMs) return;
      if (window.matchMedia("(max-width: 640px)").matches) return;
      close();
    },
    true,
  );
  window.addEventListener("resize", () => close());
  // A tap anywhere else dismisses it — the only close affordance touch has once the panel is open.
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !e.target.closest(".cell-tip") && !e.target.closest("td.sig[data-tip]")) close();
  });
}

/** The #dangerField build skeleton (children only, zero fetches) — ONE producer so lab.js
 *  buildBench and overview.js buildSkeleton cannot fork it. Pinned: lab-board.test.js. */
export function dangerFieldSkeletonHtml() {
  return `
      <div class="df-head">
        <h2 class="df-title sec-tip"${secTip("dangerLedger")}>Danger ledger</h2>
        <button class="df-toggle" id="dfToggle" type="button" aria-expanded="false" aria-controls="dfGrid">+ region/sector</button>
        <span class="df-note">sorted by own-danger → position = danger, not risk-rank</span>
        <button class="df-legend-toggle" id="dfLegendToggle" type="button" aria-expanded="false" aria-controls="dfLegend">LEGEND ▸</button>
      </div>
      <p class="df-live-line" id="dfFlipLegend"></p>
      <div class="df-legend" id="dfLegend" hidden>
        <div class="df-lgd-lead">Signal grid - tap or hover a column header for its full definition.</div>
        <div class="df-lgd-cards">
          <section class="df-lgd-card">
            <h3 class="df-lgd-t">Severity</h3>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sg-na">·</span></span><span><b>n/a</b> - nothing reports</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sg-calm">○</span></span><span><b>calm</b> - the max is GREEN</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sg-elev">◐</span></span><span><b>elevated</b> - the max is AMBER</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sg-lit">●</span></span><span><b>lit</b> - the max is RED</span></div>
            <p class="df-lgd-foot">One cell = the WORST of the members that reported into it - never an average.</p>
          </section>
          <section class="df-lgd-card">
            <h3 class="df-lgd-t">How the cell was reached</h3>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sig-abs-n">ⁿ</span></span><span>n members carried no observation into this cell's max</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="lg-absent">&nbsp;&nbsp;&nbsp;&nbsp;</span></span><span><b>dashed rule</b> - those n are simply absent</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="lg-held">&nbsp;&nbsp;&nbsp;&nbsp;</span></span><span><b>overline</b> - the member THIS NUMBER came from was RAISED by the signal-hold window: its state is an earlier close's, while the family chips show today (hover for which member, how many closes back its severity was printed, and the window)</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="leg-held">held</span></span><span><b>held</b> - the state shown is not today's live close. Two mechanisms, one word: on a board chip it is the directional 2-close FOLD (raw state disagrees with confirmed, standing down after N clean closes); the cell overline above is the signal-hold WINDOW. Hover either for which and how long.</span></div>
            <p class="df-lgd-foot">The overline follows the NUMBER, not the member: only the member that WON the cell's max is marked, so a held member out-weighed by a live one leaves the cell bare - yet its held state still enters the family's share (the weighted mean of every reporting member), so a bare cell is no proof the hold added nothing, while its own row in the drill-down still reads <i>held</i> - the same member can be overlined on one leg and not the next, because each leg weights it differently. And it never claims the cell would read calmer unheld. The hold ends the moment that member prints green, so its window is an upper bound, not a countdown.</p>
          </section>
          <section class="df-lgd-card df-lgd-wide">
            <h3 class="df-lgd-t">Lag <span class="df-lgd-sub">(rightmost column - diagnostics, NOT signal)</span></h3>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sig-lag">⌁</span></span><span>a feed behind this leg is behind</span></div>
            <div class="df-lgd-row"><span class="df-lgd-k"><span class="sig-lag">◌</span>ⁿ</span><span>n of its signal cells rest on one</span></div>
            <p class="df-lgd-foot">Soft grey = lag · bright grey = deep lag - neither grey is a signal colour.</p>
          </section>
          <section class="df-lgd-card df-lgd-wide">
            <h3 class="df-lgd-t">Mode <span class="df-lgd-sub">(danger × growth - DISPLAY-ONLY, feeds no decision)</span></h3>
            ${marketModeQuadrantHtml()}
          </section>
        </div>
      </div>
      <div class="df-grid-wrap" id="dfGridWrap"></div>
      <button class="df-below-toggle" id="dfBelowToggle" type="button" aria-expanded="false" aria-controls="dfBelow">DETAIL ▸</button>
      <div class="df-below" id="dfBelow" hidden>
        <div class="held-path" id="heldPathHost"></div>
        <p class="df-foot" id="dfFoot"></p>
        <div class="feed-lag-panel" id="feedLagPanel"></div>
      </div>`;
}

/** R4 cash-breaker footer override (the base string — lab.js appends its live overlay/cash/lag
 *  extras). ONE producer so /lab and /overview flip the SAME footer off the served d. */
export function breakerFootHtml(d) {
  const t1 = d.t1dial;
  const displayLadder = [...d.ladder, "Cash"];
  // families.ts's exact firing predicate, as lab.js's headline computes it.
  const gLive = d.globalFamilies.filter((f) => f.live).length;
  const gFiring = d.globalFamilies.filter((f) => f.firing).length;
  return (
    `<b>⛔ BREAKER</b> · <b>${gFiring} of ${gLive}</b> families firing · danger ` +
    `<b>${t1.dangerScore.toFixed(2)}</b> (${t1.regime}) - extreme, sustained, broad. The dial holds ` +
    `<b>${esc(sleeveLabel(displayLadder[t1.targetRung - 1]))} (${t1.targetRung})</b>; the breaker overrides it and ` +
    `leaves equities entirely → held <span class="held-mk">▶</span> <b>Cash</b> (off-ladder, left equities).`
  );
}

export function buildDangerField(_d) {
  const field = document.getElementById("dangerField");
  if (!field) return;
  wireCellTip(field);
  const btn = document.getElementById("dfToggle");
  // [+ region/sector] toggle — reveals the RGN/SECTOR coded columns (design §3 expanded).
  // The button is static chrome (persists), so update it directly; gate the grid via a class.
  if (btn) {
    btn.addEventListener("click", () => {
      dfShowRgn = !dfShowRgn;
      btn.setAttribute("aria-expanded", String(dfShowRgn));
      btn.textContent = (dfShowRgn ? "− " : "+ ") + "region/sector";
      const grid = document.getElementById("dfGrid");
      if (grid) grid.classList.toggle("show-rgn", dfShowRgn);
    });
  }
  // Click the held row to reveal/hide the dial's attribution (a `show-attrib` class
  // on the grid gates the .df-attrib row). Delegated on #dangerField so a grid rebuild keeps it.
  field.addEventListener("click", (e) => {
    if (e.target.closest("#dfToggle")) return; // the button owns its own listener
    // The collapsed LEGEND disclosure. Same delegated listener, not a second one —
    // `#dangerField` is the stable host that survives the applyBoard innerHTML swap. The legend is
    // static skeleton, so its open/closed state simply persists; nothing re-renders it.
    // Same resolution path for the UNDER-TABLE disclosure ([USER] 2026-08-29): everything below the
    // ledger grid — the held-leg trajectory log and the `#dfFoot` sentence — ships collapsed behind
    // `DETAIL ▸`. Both toggles carry `aria-controls`, so one branch resolves either by id; the hosts
    // themselves stay in the skeleton, so the per-board writes into `#dfFoot`/`#heldPathHost` are
    // untouched and the open state simply persists across a rebuild.
    const discloseBtn = e.target.closest(".df-legend-toggle, .df-below-toggle");
    if (discloseBtn) {
      const body = document.getElementById(discloseBtn.getAttribute("aria-controls"));
      if (body) toggleDisclosure(discloseBtn, body);
      return;
    }
    const heldRow = e.target.closest(".df-row.held.has-attrib");
    if (!heldRow) return;
    dfShowAttrib = !dfShowAttrib;
    // Re-measure on OPEN: the render-time call may have landed while the wrapper had no layout,
    // and this is the first moment the reveal is guaranteed on screen.
    if (dfShowAttrib) fitAttribWidth();
    const grid = document.getElementById("dfGrid");
    if (grid) grid.classList.toggle("show-attrib", dfShowAttrib);
  });
}

/** Every applyBoard: rewrite the ledger grid (+ default footer) from the once-computed field.
 *  Pure projection — no resolveField call, no retained state; dfShowRgn/dfShowAttrib are
 *  re-applied as grid classes so the open state survives the rebuild. */
// #R2: explain-tooltip for a leg's concentration badge — which cluster sibling is elevated,
// at what own-danger, against the served concThreshold/concWeight the auto-hold pick applies.
function concentrationTitle(leg, dangerBySleeve) {
  const model = dangerModel || {};
  const clusters = model.clusters || [];
  const ct = model.concThreshold;
  const cw = model.concWeight;
  // Auto-hold knobs unavailable (the separate /api/danger-model fetch failed) → no tooltip text,
  // matching the pre-fallback behavior for a null dangerModel.
  if (ct == null || cw == null) return "";
  const cluster = clusters.find((c) => c.includes(leg.sleeve));
  // The served /api/danger-model `clusters` is the STATIC base [[Semis, S&P IT]]; it can't carry
  // DISP's state-conditional widen (EM joins the "one bet" only while DISP is AMBER/RED, engine-side,
  // via `DISP_WIDE_CLUSTERS`). So the badge can light for two reasons the served cluster can't name:
  //   (a) EM itself is concentrated — EM is absent from every served cluster; or
  //   (b) a base leg (Semis/S&P IT) is concentrated because the UNSEEN EM sibling is elevated while
  //       its served base sibling is calm — the detailed list would then contradict itself
  //       ("sibling elevated (≥ ct): S&P IT 0.00").
  // `dangerBySleeve` is the pre-overlay own-danger (the same quantity the engine's concentration test
  // compares to CONC_THRESHOLD), so `servedSibElevated` reproduces the base-cluster decision exactly:
  // if it's false while the badge is lit, an unseen widen sibling (EM) drove it → generic fallback.
  const servedSibElevated =
    !!cluster &&
    cluster.some((s) => s !== leg.sleeve && (dangerBySleeve.get(s) ?? 0) >= ct);
  if (!servedSibElevated) {
    return `#R2 concentration - a cluster sibling is elevated (absolute own-danger ≥ ${ct}). Auto-hold weights sibling danger ×${cw} against this leg's own when picking the in-band sleeve to hold.`;
  }
  const sibs = cluster
    .filter((s) => s !== leg.sleeve)
    .map((s) => `${sleeveLabel(s)} ${(dangerBySleeve.get(s) ?? 0).toFixed(2)}`)
    .join(", ");
  return `#R2 concentration - cluster sibling elevated (absolute own-danger ≥ ${ct}): ${sibs}. Auto-hold weights sibling danger ×${cw} against this leg's own when picking the in-band sleeve to hold.`;
}

/* ---- Two-pillar ledger idioms.
 *  Column composition — `Danger | Early-warn | Stress-now | Exo`:
 *    Danger     = `<served share-lit `danger` = max(EW, SN, gated trend, exo gp)>` (the board's sort key) + the PAIRED `E`/`S` bar stack.
 *                 The bars stay a paired unit in ONE cell BY DESIGN (USER): their
 *                 job is the E-vs-S correlation read, which splitting per-pillar would destroy —
 *                 hence the `E`/`S` letters stay ON the bars.
 *    Early-warn = `<EW share numeral><EW 20-close speed arrow>` over `<N/M families lit>`
 *    Stress-now = `<SN share numeral><SN 5-close speed arrow>` over `<N/M families lit>`
 *    Exo        = `X<EXO weather glyph>`
 *  Headers carry the pillar names, so the NUMERALS take no inline `E`/`S` prefix (USER).
 *  Each idiom is its OWN render helper + OWN CSS class scope (lg-glyph / lg-bars / lg-exo) so a
 *  prune = delete one helper call + its CSS block. All only re-express server-sent values
 *  (`subDangers`, `familiesLit`, `snRoc`, `ewRoc`, `danger`, `field.exogenous`, G1's confirmed state) via the
 *  sub-dangers.js pure builders — NO client-side pillar aggregation (`danger` is the SERVED sort
 *  key, never a client max()). Every element carries a STATE-SPECIFIC meaning-title. */

/** Shared numeral model for the band-coloured ×100 numerals on the leg's own scale (Danger / Early-warn cells). A null /
 *  absent value ⇒ `–` + the `na` band (absent, not zero) — mirroring the `snRoc`/bar convention. */
function pillarNum(v) {
  return typeof v === "number" && !Number.isNaN(v)
    ? { text: String(Math.round(v * 100)), band: bandClass(v) }
    : { text: "-", band: "na" };
}

/** Ledger numeral value on the leg's own (share) scale: `danger` and the EW/SN `subDangers` shares as served. */
export function onLegScale(l, key) {
  if (key === "danger") return l.danger;
  return pillarValue(l.subDangers ? l.subDangers[key] : null);
}

/** `<lit>/<of> lit` under the EW/SN numeral from the served `familiesLit[key]`; "" when absent or `of` is 0. */
export function renderFamiliesLit(l, key) {
  const c = l.familiesLit ? l.familiesLit[key] : null;
  if (!c || !(c.of > 0)) return "";
  const pillar = key === "earlyWarn" ? "early-warning" : "stress-now";
  const title =
    `${c.lit}/${c.of} families lit - ${c.lit} of the ${c.of} ${pillar} families reporting on this leg sit at or above the amber cut. ` +
    "A count only: the number above is the weighted share, not this tally";
  return `<span class="lg-lit" title="${esc(title)}">${c.lit}/${c.of} lit</span>`;
}

/** State-specific titles for the SN number — the active band's meaning + impact, never a legend. */
const SN_NUM_TITLE = {
  na: "STRESS-NOW - no live stress-family cell covers this leg; the number is absent, not zero",
  g: (n) => `STRESS-NOW ${n} (of 100 = every input lit) - calm: live market stress on this leg is low right now`,
  a: (n) => `STRESS-NOW ${n} (of 100 = every input lit) - amber: live stress is pressing on this leg now`,
  r: (n) => `STRESS-NOW ${n} (of 100 = every input lit) - red: live stress is hitting this leg hard now`,
};

/** SN number on the leg's own scale (band-coloured) immediately followed by
 *  the 5-close speed arrow (anchor ordering: every arrow reads `<anchor><arrow>`). A missing
 *  `snRoc` (scenario / degraded / SN-not-live) renders no arrow. */
export function renderSnSpeed(l) {
  const n = pillarNum(onLegScale(l, "stressNow"));
  const numTitle = n.band === "na" ? SN_NUM_TITLE.na : SN_NUM_TITLE[n.band](n.text);
  const spd = snSpeedArrow(l.snRoc);
  const arrow = spd.glyph
    ? `<span class="lg-spd ${spd.cls}" title="${esc(spd.title)}">${spd.glyph}</span>`
    : "";
  return (
    `<span class="lg-glyph">` +
    `<span class="lg-dotv ${n.band}" title="${esc(numTitle)}">${esc(n.text)}</span>${arrow}</span>`
  );
}

/** State-specific titles for the Trend numeral (own scope, prune = 1 delete). */
const TREND_NUM_TITLE = {
  na: "TREND - no live confirming-trend (uT) cell covers this leg; the number is absent, not zero",
  gated: (n) =>
    `TREND (${n}) - gated off: neither EARLY-WARN nor STRESS-NOW is lit, so this trend does NOT count toward the leg's danger`,
  counting: (n) =>
    `TREND ${n} (of 100 = every input lit; a leg with little trend exposure tops out lower) - counting: EARLY-WARN or STRESS-NOW is lit, so this trend counts toward the leg's danger (full weight once either reaches the floor)`,
};

/** The per-leg CONFIRMING-trend numeral (served `trend.value` = `trendShare`, ×100). NO speed arrow (no
 *  `trendRoc` exists — number only). `l.trend.value == null` → `–` (na, absent not zero);
 *  `counting` → bright band-coloured number (it counts toward `danger`); gated-off (present but
 *  `!counting`) → dimmed + parenthesized `(n)` so a calm leg's trend stays legible without reading
 *  as live danger. Mirrors `pillarNum` / `renderSnSpeed`. */
export function renderTrend(l) {
  const v = l.trend ? l.trend.value : null;
  if (typeof v !== "number" || Number.isNaN(v)) {
    return `<span class="lg-glyph"><span class="lg-dotv na" title="${esc(TREND_NUM_TITLE.na)}">-</span></span>`;
  }
  const n = Math.round(v * 100);
  if (!(l.trend && l.trend.counting)) {
    return `<span class="lg-glyph"><span class="lg-dotv trend-gated" title="${esc(TREND_NUM_TITLE.gated(n))}">(${n})</span></span>`;
  }
  return `<span class="lg-glyph"><span class="lg-dotv ${bandClass(v)}" title="${esc(TREND_NUM_TITLE.counting(n))}">${n}</span></span>`;
}

/** State-specific titles for the OWN-DANGER numeral (the sort key, served `danger`). */
const DANGER_DRIVERS = "the max of EARLY-WARN, STRESS-NOW, the gated trend term and the exogenous term";
const DANGER_NUM_TITLE = {
  na: "OWN-DANGER - no live pillar covers this leg; the number is absent, not zero",
  g: (n) => `OWN-DANGER ${n} (of 100 = every input lit) - calm: ${DANGER_DRIVERS} is low; it sorts to the bottom of the board`,
  a: (n) => `OWN-DANGER ${n} (of 100 = every input lit) - amber: ${DANGER_DRIVERS} is elevated; it sorts up the board`,
  r: (n) => `OWN-DANGER ${n} (of 100 = every input lit) - red: ${DANGER_DRIVERS} is firing; it sorts to the top of the board`,
};

/** The sort-key numeral (`danger` ×100, band-coloured), leading its column ahead of the
 *  paired E/S bars: row position is `danger` desc, so the number that drives it is readable.
 *
 *  The EARLY-WARN percentile (of the EW pillar's stored history) stacks UNDER that numeral. **Accepted semantic drift**: it
 *  reads as "this LEG ranks p61 historically" rather than "this BAR is p61". Ruled acceptable;
 *  do NOT add a second percentile inside the E bar to compensate. The column stack is CSS
 *  (`.df-grid .col-danger .lg-glyph` in lab.html) — this markup only changes which slot it rides. */
export function renderDangerNum(l) {
  const n = pillarNum(onLegScale(l, "danger"));
  const title = n.band === "na" ? DANGER_NUM_TITLE.na : DANGER_NUM_TITLE[n.band](n.text);
  return (
    `<span class="lg-glyph"><span class="lg-dotv ${n.band}" title="${esc(title)}">${esc(n.text)}</span>` +
    `${pctBadge(l.ewPct)}</span>`
  );
}

/** State-specific titles for the EW numeral — sibling of SN_NUM_TITLE, own scope (prune = 1 delete). */
const EW_NUM_TITLE = {
  na: "EARLY-WARN - no live early-warning family covers this leg; the number is absent, not zero",
  g: (n) => `EARLY-WARN ${n} (of 100 = every input lit) - calm: forward-looking gauges low; nothing brewing ahead for this leg`,
  a: (n) => `EARLY-WARN ${n} (of 100 = every input lit) - amber: forward-looking gauges elevated; stress may be building before prices confirm`,
  r: (n) => `EARLY-WARN ${n} (of 100 = every input lit) - red: forward-looking gauges firing; stress likely heading for this leg`,
};

/** EW number on the leg's own scale + its 20-close speed arrow (`ewRoc`), the sibling of `renderSnSpeed`
 *  (same `<anchor><arrow>` ordering). A missing `ewRoc` (cold-start rows whose t−20 base was never
 *  OBSERVED, scenario / degraded loads) renders no arrow — exactly as `snRoc` behaves. */
export function renderEwSpeed(l) {
  const n = pillarNum(onLegScale(l, "earlyWarn"));
  const numTitle = n.band === "na" ? EW_NUM_TITLE.na : EW_NUM_TITLE[n.band](n.text);
  const spd = ewSpeedArrow(l.ewRoc);
  const arrow = spd.glyph
    ? `<span class="lg-spd ${spd.cls}" title="${esc(spd.title)}">${spd.glyph}</span>`
    : "";
  return (
    `<span class="lg-glyph">` +
    `<span class="lg-dotv ${n.band}" title="${esc(numTitle)}">${esc(n.text)}</span>${arrow}</span>`
  );
}

/** State-specific titles for the pillar bars — active state's meaning + impact per band. */
const BAR_TITLE = {
  E: {
    na: "EARLY-WARN - no live early-warning family covers this leg; the E bar is absent, not zero",
    g: (n) => `EARLY-WARN ${n} (×100) - calm: forward-looking gauges low; nothing brewing ahead for this leg`,
    a: (n) => `EARLY-WARN ${n} (×100) - amber: forward-looking gauges elevated; stress may be building before prices confirm`,
    r: (n) => `EARLY-WARN ${n} (×100) - red: forward-looking gauges firing; stress likely heading for this leg`,
  },
  S: {
    na: "STRESS-NOW - no live stress family covers this leg; the S bar is absent, not zero",
    g: (n) => `STRESS-NOW ${n} (×100) - calm: live market stress on this leg is low right now`,
    a: (n) => `STRESS-NOW ${n} (×100) - amber: live stress is pressing on this leg now`,
    r: (n) => `STRESS-NOW ${n} (×100) - red: live stress is hitting this leg hard now`,
  },
};

/** Dual thin-bar stack, one-letter labels E/S, framed tracks, band-cut ticks at the
 *  ACTIVE served cuts (bandTicks — never hard-coded), calm sliver instead of an empty track
 *  (pillarBar floors a measured value). CONFIRMING (uT) gets no bar; EXOGENOUS rides the glyph. */
// Coverage: the coverage fact rides the pillar bar's TOOLTIP, and only when it says something —
// i.e. only when
// `live < capable`. Full coverage is the normal state and prints nothing at all, on either bar.
// Still gated at `capable >= 2` — single-family super-groups (CONFIRMING/EXOGENOUS) have no coverage
// story to tell. `coverage` may be absent on an older cached payload —
// a missing field yields no clause rather than the literal `undefined`.
// EARLY-WARN percentile badge: the leg's EW pillar ranked
// against its own stored history —
// `renderDangerNum` stacks it under the danger
// cell's sort-key numeral (see that function's docblock). Four-arm tagged union (`PercentileCell`, src/api/types.ts) — `warmup` / `na` /
// `stale-basis` all print `—`; the `pct` arm prints a BARE `p62`, and `p62~` (`.lg-pct.est`) when the
// ranked window spans a roster change (`basisSpans`), with `SPANS_CLAUSE` naming the dates.
//
// The `pct` title states the ROLL-OFF consequence explicitly (spec §2): this is a ROLLING window,
// so the reading moves with NO new data when an old close drops out the back of it. Never present
// the badge as fresh-close-driven.
//
// `ewPct` may be absent on an older cached payload — a missing field renders nothing rather than
// the literal `undefined`. Pure in its one arg (no closure) so `leg-percentile-badge.test.js` can
// lift it out of THIS file by regex and exercise the SHIPPED source.
function pctBadge(ewPct) {
  // The window length is stated in the title as a literal because this file is unbundled browser
  // ESM and cannot import `ECDF_WINDOW` from src/. `leg-percentile-badge.test.js` pins the literal
  // against the TS constant, so the copy cannot drift from the arithmetic.
  const PCT_TITLE =
    "EARLY-WARN percentile - where this leg pillar sits inside the last 500 stored closes of its own history. " +
    "ROLLING WINDOW, so the reading moves with NO new data: when an old close falls out the back of the " +
    "500-close window the comparison set itself changes, and the same pillar value can rank differently the " +
    "next day. Not a fresh-close reading.";
  // `basisSpans` carries the roster-change dates the ranked window straddles — a statement about the
  // COMPARISON SET, not the ranked value.
  const SPANS_CLAUSE = (dates) =>
    ` - the 500-close window SPANS a rates-roster change on ${dates}: closes before it were computed ` +
    "off a SMALLER member set and read colder, so the rank is not a like-for-like comparison. " +
    "This clears itself as the window rolls past the change.";
  const TITLES = {
    warmup: "EARLY-WARN percentile - not enough stored history for this leg yet; never imputed",
    na: "EARLY-WARN percentile - this pillar is uncomparable, so a rank over it would be meaningless",
    "stale-basis":
      "EARLY-WARN percentile - the stored history was computed by an older engine vintage; a stale rank is never served",
  };
  // The `pct` arm first: it is the only arm carrying data, so it is the only one that can be
  // MALFORMED. A non-finite `value` falls through to "" rather than painting `pNaN`.
  if (ewPct && ewPct.kind === "pct") {
    if (typeof ewPct.value !== "number" || !Number.isFinite(ewPct.value)) return "";
    // Server-supplied dates, interpolated into an attribute WITHOUT `esc()` (staying closure-free is
    // what lets the suite lift this helper), so they are WHITELISTED to the ISO-date alphabet and
    // capped in count/length exactly like the stale-basis vintage tags below — a `"` out of a
    // garbled column would otherwise break out of the title. Hostile input degrades, never to markup.
    const spans = Array.isArray(ewPct.basisSpans)
      ? ewPct.basisSpans
          .map((d) => (typeof d === "string" ? d.replace(/[^0-9-]/g, "") : "").slice(0, 10))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    // A spanned window is never a clean like-for-like rank, so it earns the `~`.
    const est = spans.length > 0;
    const cls = est ? "lg-pct est" : "lg-pct";
    const title = PCT_TITLE + (est ? SPANS_CLAUSE(spans.join(", ")) : "");
    // BARE `p62` / `p62~`, no parentheses — `leg-percentile-badge.test.js` pins the bare form.
    return `<span class="${cls}" title="${title}">p${Math.round(ewPct.value * 100)}${est ? "~" : ""}</span>`;
  }
  // `Object.hasOwn` guard, not a bare lookup: `TITLES[ewPct.kind]` inherits from Object.prototype, so
  // a payload carrying `{kind:"constructor"}` / `{kind:"toString"}` would yield a truthy FUNCTION and
  // paint `—` with `function Object() { [native code] }` inside the title attribute.
  let title = ewPct && Object.hasOwn(TITLES, ewPct.kind) && TITLES[ewPct.kind];
  if (!title) return "";
  // Name the two vintages on the stale arm, so "an older engine vintage" is
  // actionable (which vintage is stored, which one this deploy computes) rather than a mood.
  //
  // ⚠ These are the ONLY server-supplied strings this helper interpolates, and it deliberately
  // does NOT call `esc()` (staying closure-free is what lets the suite lift the shipped source).
  // So they are WHITELISTED to the vintage alphabet — `ew-` + hex, plus `._` slack — and length-
  // capped, rather than escaped: a `"` from a compromised/garbled `generator` column would
  // otherwise break out of the title attribute. Hostile input degrades to `?`, never to markup.
  if (ewPct.kind === "stale-basis") {
    const tag = (g) => (typeof g === "string" ? g.replace(/[^A-Za-z0-9._-]/g, "") : "").slice(0, 32) || "?";
    title += ` - stored ${tag(ewPct.stored)}, live ${tag(ewPct.live)}`;
  }
  // No `esc()` call on purpose: the titles are author-controlled literals defined a few lines
  // above, never server data, and keeping the helper closure-free is what lets its suite lift the
  // SHIPPED source instead of a hand-typed mirror. The suite pins that they stay attribute-safe.
  return `<span class="lg-pct" title="${title}">—</span>`;
}

// The coverage shortfall AS A CLAUSE appended to the bar's own tooltip. Returns "" whenever the
// fact is not worth saying (full coverage, single-family super-group, absent payload), so a silent
// return is the common case, not a failure. Pure in its two args and closure-free,
// so `leg-coverage-badge.test.js` can keep lifting it out of THIS file by regex
// and exercise the SHIPPED source. Carries NO leg / family / pillar proper name by construction —
// no name to sync, the same way `CLAMP_CLAUSE` carries none.
function coverageClause(coverage, superGroup) {
  const c = coverage && coverage[superGroup];
  if (!c || c.capable < 2 || c.live >= c.capable) return "";
  if (c.live === 0) {
    return (
      ` - NO LIVE COVERAGE: none of the ${c.capable} families capable of reaching this leg is reporting` +
      " a live reading on this pillar, so nothing measured sits behind the number"
    );
  }
  return (
    ` - PARTIAL COVERAGE: live readings on this pillar cover only ${c.live} of the ${c.capable} families` +
    " capable of reaching this leg, so the number rests on a thinner set than the pillar's full definition"
  );
}

// A thin COMPOSER: the per-bar markup lives in the pure seam `sub-dangers.js` `pillarBarHtml`, which its own suite tests by import. Only
// the ticks and `coverageClause` stay here — the clause because `leg-coverage-badge.test.js` lifts it
// out of THIS file by regex, and the ticks because they are a per-render constant of the pair.
function renderPillarBars(l) {
  const sd = l.subDangers || {};
  // `bandTicks`' `band` field REACHES the markup as a class, so each
  // hairline can take its own colour: a bright #f9a825 backdrop caps ANY light neutral near 1.9
  // contrast, so a per-band rule is the only fix. Styled in lab.html
  // (`.lg-bar-tick.a` / `.r`) and measured on the rendered pixels by `npm run preview:ticks`.
  const ticks = bandTicks()
    .map((t) => `<span class="lg-bar-tick ${t.band}"${posAttrs({ left: t.pct })}></span>`)
    .join("");
  // The bar row is label + track only. `clauses` is the seam's open-ended tooltip-suffix channel —
  // append to the array, never concatenate into `titles`.
  const bar = (lbl, pillar, superGroup) =>
    pillarBarHtml(lbl, pillar, {
      ticksHtml: ticks,
      clauses: [coverageClause(l.coverage, superGroup)],
      titles: BAR_TITLE[lbl],
    });
  return `<span class="lg-bars">${bar("E", sd.earlyWarn, "EARLY-WARN")}${bar("S", sd.stressNow, "STRESS-NOW")}</span>`;
}

/** The feed-lag footnote under the ledger. The MARKUP lives in the pure seam
 *  `feed-lag-foot.js` (its nullable-`age`/`p90Gap` guard is
 *  load-bearing and nothing inside `lab.js` is reachable by a test). This composer supplies the one
 *  thing the seam refuses to reach for — the served member-label map. */
export function feedLagFoot(notes) {
  return feedLagFootHtml(notes, (dangerModel && dangerModel.memberLabel) || {});
}

/** The feed-lag PANEL — a lazy disclosure (§4.3) over the whole `/api/status.feedLag` roster. Markup
 *  + state machine live in the pure seam `feed-lag-panel.js`; `lab.js` owns the fetch/lifecycle and
 *  passes the disclosure `state`. This composer supplies the served member-label map, mirroring
 *  `feedLagFoot`. */
export function feedLagPanel(state) {
  return feedLagPanelShellHtml(state, (dangerModel && dangerModel.memberLabel) || {});
}

/** `X` anchor + EXOGENOUS weather glyph (▶/▲/▲▲, band-coloured), one per row
 *  (the glyph is a FIELD-LEVEL weather read, so the same one repeats on every row — it is NOT a
 *  per-leg magnitude, and there is no uniform overlay floor behind it either;
 *  each leg carries its own weighted oil danger, see `renderDangerField`'s note below). `exo` is
 *  computed once per render in renderDangerField from G1's live confirmed state + the served floor. */
function renderExoGlyph(exo) {
  return (
    `<span class="lg-exo"><span class="lg-exo-x" title="${esc(exo.title)}">X</span>` +
    `<span class="lg-arrow ${exo.band}" title="${esc(exo.title)}">${exo.glyph}</span></span>`
  );
}

// Example buyable EUR-UCITS per sleeve (the "card" the user holds/buys). Tooltip-only; the
// scoring series can differ.
const SLEEVE_ETF = {
  Semis: "SEC0.DE",
  "S&P IT": "QDVE.DE",
  EM: "IS3N.DE",
  Value: "XDEV.DE",
  "S&P 500": "SXR8.DE",
  "ex-US": "CHSI.DE",
  "EU-Fin": "DE0002635299",
  Health: "QDVG.DE",
  Staples: "ZPDS.DE",
};

/** Clamp the held-row reveal to the ledger's VISIBLE width ([USER] 2026-09-06).
 *  The reveal renders inside a `<td colspan>` of `.df-grid`, and that table is deliberately wider
 *  than a phone (see the shrink-to-content column widths in lab.css — "mobile fit is deferred").
 *  A `<td>`'s content box is the TABLE's width, so the prose laid itself out off-screen and had to
 *  be read by scrolling sideways. CSS inside the cell cannot see the scroll ancestor's width, so it
 *  is measured here and handed to the sheet as `--attrib-w` (minus the cell's 8px×2 padding);
 *  `.attrib-fit` pairs it with `position: sticky; left: 0` so the text stays at the visible edge
 *  when the ledger IS scrolled. CSSOM, not a `style=` attribute — prod drops those (frontend rule).
 *  Idempotent and cheap (one `clientWidth` read); safe to call on every render. */
function fitAttribWidth() {
  const wrap = document.getElementById("dfGridWrap");
  if (!wrap) return;
  // A ZERO measurement is never committed. `clientWidth` reads 0 whenever the wrapper is not laid
  // out (the board painted behind an inactive view, a display:none ancestor), and writing that
  // through collapses the reveal to a 0px column that wraps one character per line — caught by
  // §1b of the mobile audit, which measured `boxWidth: 0` on exactly that path. Bailing leaves the
  // sheet's `100%` fallback, which is merely un-clamped (the pre-fix behaviour), never invisible.
  const w = wrap.clientWidth - 16;
  if (w <= 0) return;
  wrap.style.setProperty("--attrib-w", `${w}px`);
}
let attribFitWired = false;

export function renderDangerField(field, d) {
  const wrap = document.getElementById("dfGridWrap");
  if (!wrap) return;
  // Drop the previous render's panels before the cells that keyed them are replaced — a key that
  // survives its cell is a panel nothing can open and a leak across rebuilds.
  closeCellTip();
  cellTips.clear();
  const { legRows, band, held } = field;
  const dangerBySleeve = new Map(legRows.map((r) => [r.sleeve, r.danger]));
  // EXO weather glyph state — computed ONCE per render off G1's live confirmed state (same wire as
  // the signal grid) + the served `exogenous.floor`.
  // ⚠ There is no overlay — each leg carries its OWN weighted oil danger inside `r.danger`,
  // and `exogenous.floor` is the MINIMUM of those across the 9 legs. The glyph is a G1 weather read
  // (per-member `gp` state is not served), not a status read-out of the engine term — see
  // `exoGlyph`'s docblock in sub-dangers.js for that scope note.
  // An unreported G1 is `undefined` here (no key), and it is
  // passed through as such rather than imputed `calm`. `exoGlyph` owns the absent arm — the same
  // `▶`/no-danger OUTCOME the engine takes for an absent member (excluded from the Level-1 max,
  // never substituted), but with a title that says the feed did not report instead of asserting a
  // measurement of calm oil.
  const exo = exoGlyph(
    buildMemberState(d)["G1"],
    (d.field && d.field.exogenous && d.field.exogenous.floor) || 0,
  );
  // Rows sorted by own-danger desc (design §4): vertical position encodes danger, NOT risk.
  // Copy before sorting — the field is shared across the 3 renderers + cached (no in-place mutate).
  const rows = [...legRows].sort((a, b) => onLegScale(b, "danger") - onLegScale(a, "danger"));

  // Signal-grid columns follow the SERVED family order (d.globalFamilies) — the canonical family
  // order (cr, rt, vb, vl, xa, uT, gp — super-group lead-time order EARLY-WARN → STRESS-NOW →
  // CONFIRMING → EXOGENOUS).
  // Header key = the danger-model SignalKey bijection; header tooltip = the family's served desc.
  // Cells are re-indexed by cell.family below so a column always renders its own family's cell
  // regardless of server order.
  //
  // Robustness fallback: /api/danger-model is a SEPARATE serverless fn. If it fails, `dangerModel`
  // is null and we have NO long→2-letter (`credit`→`cr`) bijection client-side — the cells stay
  // keyed by the 2-letter `cell.family`, so keying columns by the long `f.key` would make EVERY
  // cell miss and blank the whole signal grid. Rather than mis-key, collapse the signal columns to
  // a single visible "grouping unavailable" placeholder (keeps sleeve/danger/risk rendering). No-op
  // on the happy path (model present ⇒ the exact prior column set, byte-identical).
  const hasModel = !!(dangerModel && dangerModel.signalOf);
  const sigCols = hasModel
    ? (d.globalFamilies || []).map((f) => ({
        key: dangerModel.signalOf[f.key] || f.key,
        def: f.desc || "",
      }))
    : [{ key: "signals n/a", def: "signal grouping unavailable - /api/danger-model failed to load" }];

  const head =
    `<th class="col-sleeve">Sleeve</th>` +
    `<th class="col-rgn" title="Region (factual, off the buyable-UCITS catalog): US · exUS dev-ex-US · EM emerging · DM developed-world · AW all-world · EU europe">RGN</th>` +
    `<th class="col-sector" title="Exposure / sector - the leg's defining trait (short code, never colour)">Sector</th>` +
    `<th class="col-danger" title="Own-danger = max(EARLY-WARN, STRESS-NOW, gated TREND, capped OIL share) on this leg's own scale (100 = every input lit) - the board's sort key (rows run danger desc) · paired anatomy bars: E = EARLY-WARN, S = STRESS-NOW (fill = level, ticks = amber/red cuts) - side by side so you can read whether the two pillars agree">Danger` +
    // The bar axis stated ONCE, DERIVED from `BAR_FULL_SCALE` — never a second literal.
    `<span class="col-axis">bars: full = ${Math.round(BAR_FULL_SCALE * 100)} (×100, absolute), numerals = leg's own scale</span></th>` +
    `<th class="col-ew" title="EARLY-WARN pillar on this leg's own scale (100 = every input lit) + its 20-close speed arrow - forward-looking gauges (monthly/quarterly members), stress building before prices confirm">EW</th>` +
    `<th class="col-sn" title="STRESS-NOW pillar on this leg's own scale (100 = every input lit) + its 5-close speed arrow - live market stress hitting this leg right now">SN</th>` +
    `<th class="col-trend" title="CONFIRMING trend (uT) on this leg's own scale (100 = every input lit; a leg with little trend exposure tops out lower) - the 3rd term in max(EW, SN, gatedTrend, capped oil share). Bright = counting (EW or SN lit, so it counts toward danger; full weight once either reaches the floor); dimmed (n) = present but gated off; - = no live trend cell">Trend</th>` +
    // The cell is an ARROW, not the label text. The glyph set is
    // NOT restated here: it is `MARKET_MODE_GLYPHS` (market-mode.js), rendered into the tooltip via
    // `MODE_ARROW_LEGEND` so a retune has one touch point. The arrows deliberately do NOT separate
    // accumulation from markup on their own; the footnote under the grid carries each mode's name,
    // meaning AND implication, which is what does.
    `<th class="col-mode" title="Market mode - the leg's danger×growth quadrant as a Wyckoff cycle phase, painted as an arrow (${MODE_ARROW_LEGEND} · ${MODE_NA_GLYPH} growth not live). DISPLAY-ONLY: a read-off of the served danger + growth, feeds nothing (never touches selection or danger). The footnote under the grid says what each arrow means and implies.">Mode</th>` +
    `<th class="col-exo" title="X = EXOGENOUS oil weather (▶ calm / ▲ elevated / ▲▲ red) - the G1 read. Oil danger can differ per row: each leg carries its own oil share (capped just below amber) inside the Danger column, so oil alone never sets a band">Exo</th>` +
    sigCols.map((s) => `<th class="sig-h" title="${esc(s.def)}">${esc(s.key)}</th>`).join("") +
    `<th class="col-risk" title="Risk rung - the leg's fixed seat on the 1-9 ladder (r1 most aggressive, r9 cash). A standing property of the sleeve: never a score, never a read of today. The dial's band is the WINDOW of rungs today's signal allows; the held leg is chosen by danger from inside that window, so it need not match the dial's ● target rung - open the held row for the pick trace.">risk</th>` +
    // The feed-lag marks are DIAGNOSTICS, not operational
    // signal, so BOTH live here at the right edge: `⌁` (the leg roll-up)
    // and `◌ⁿ` (the cell marks).
    `<th class="col-lag" title="Feed lag - DIAGNOSTICS, not signal: ⌁ = at least one feed behind this leg is lagging · ◌ⁿ = how many of the leg's signal cells rest on such a feed. Both tiers paint from a neutral diagnostics ramp - neither is a signal colour: soft grey = lag (behind but reporting) · bright grey = deep lag (broke its own published rhythm). The footnote under the grid names the lagging feeds.">Lag</th>`;

  // The dial's band→depth attribution, revealed as an expandable row under the
  // held sleeve. Frozen with the ledger.
  // sleeve+rgn+sector+danger+ew+sn+trend+mode+exo + N signals + risk + lag. The `+ 2` tail is
  // the `Lag` column — header, row cell and this constant are one change (a half-move
  // misaligns every `df-attrib` colspan silently).
  const NCOLS = 9 + sigCols.length + 2;
  const attribHtml = buildAttribHtml(d, d.t1dial, [...d.ladder, "Cash"], held, legRows);
  // Mode danger split = the SERVED leg green→amber cut (agrees with every other danger colouring
  // on /lab); a missing danger-model payload keeps sub-dangers.js's matching BAND_CUTS default.
  const modeAmber = dangerModel?.legRagCuts?.amber ?? BAND_CUTS.amber;
  const body = rows
    .map((l) => {
      const isHeld = !!held && l.sleeve === held.sleeve;
      // Render from the precomputed cells (computeCells) — no second cellState derivation.
      // Re-index by cell.family so each column shows its OWN family's cell in the served
      // sigCols order (server cell order need not match the family/column order).
      const cellByFam = new Map(l.cells.map((c) => [c.family, c]));
      const sigCells = sigCols
        .map((col) => {
          const c = cellByFam.get(col.key);
          if (!c) return `<td class="sig sg-na"></td>`;
          // The drill-down markup is parked in `cellTips` and reached by key, not inlined per cell:
          // 9 legs × the signal columns would put ~70 hidden panels in the grid on every rebuild, and
          // only one is ever on screen. The key is the (sleeve, family) pair the render already has.
          const key = `${l.sleeve}|${c.family}`;
          if (c.tip) cellTips.set(key, c.tip);
          return `<td class="sig ${c.cls}"${c.tip ? ` data-tip="${esc(key)}" tabindex="0"` : ""}>${c.g}${c.mk || ""}</td>`;
        })
        .join("");
      const concBadge = l.concentrated
        ? ` <span class="conc-tag" title="${esc(concentrationTitle(l, dangerBySleeve))}">⚠ conc</span>`
        : "";
      const row =
        `<tr class="df-row${isHeld ? " held" : ""}"${isHeld && attribHtml ? ' title="click to reveal the dial\'s band→depth reasoning"' : ""}>` +
        `<td class="col-sleeve">${isHeld ? '<span class="held-mk">▶</span> ' : ""}` +
        // Short leg KEY only ([USER] 2026-10-04): the ledger column stays narrow; the ticker rides the title.
        `<span class="sleeve-name"${SLEEVE_ETF[l.sleeve] ? ` title="e.g. ${esc(SLEEVE_ETF[l.sleeve])}"` : ""}>${esc(l.sleeve)}</span>${concBadge}</td>` +
        `<td class="col-rgn" title="${esc(l.region)}">${esc(l.rgn)}</td>` +
        `<td class="col-sector" title="${esc(l.sector)}">${esc(l.sec)}</td>` +
        `<td class="col-danger">${renderDangerNum(l)}${renderPillarBars(l)}</td>` +
        `<td class="col-ew">${renderEwSpeed(l)}${renderFamiliesLit(l, "earlyWarn")}</td>` +
        `<td class="col-sn">${renderSnSpeed(l)}${renderFamiliesLit(l, "stressNow")}</td>` +
        `<td class="col-trend">${renderTrend(l)}</td>` +
        `<td class="col-mode">${marketModeCellHtml(marketMode(l.danger, l.growth, modeAmber))}</td>` +
        `<td class="col-exo">${renderExoGlyph(exo)}</td>` +
        sigCells +
        `<td class="col-risk">r${l.risk}${isHeld ? ' <span class="held-tag">◄ held</span>' : ""}</td>` +
        // Both feed-lag marks, pre-computed in the pure seam by resolveField; nothing
        // here re-reads a census. Both stay suppressed when
        // `!hasModel`: they summarise the leg's SIGNAL CELLS, and on the degraded path `sigCols`
        // collapses to the `signals n/a` placeholder so every cell renders empty — a mark with
        // nothing on screen to attribute it to breaks the "summarises the cells" contract.
        `<td class="col-lag">${hasModel && l.lagMark ? l.lagMark.html : ""}${hasModel && l.cellLagMark ? l.cellLagMark.html : ""}</td>` +
        `</tr>`;
      // The attribution expandable rides directly under the held row (off by default).
      const attribRow =
        isHeld && attribHtml ? `<tr class="df-attrib"><td colspan="${NCOLS}">${attribHtml}</td></tr>` : "";
      return row + attribRow;
    })
    .join("");

  setHTML(wrap, `<table class="df-grid" id="dfGrid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  // Measure AFTER the write (the wrapper's clientWidth is stable, but the var must exist before the
  // reveal is first shown) and keep it true across orientation changes / window resizes.
  fitAttribWidth();
  if (!attribFitWired) {
    attribFitWired = true;
    window.addEventListener("resize", fitAttribWidth);
  }

  // Held-leg trajectory. Row
  // derivation + every string live in the pure `held-path.js` seam; this is the DOM write only.
  // SCENARIO ONLY: the live path also carries `walkPath` when the URL asks for one, but "where my
  // hold drifts if today never changes" is a counterfactual question, so it paints under `?s=`.
  // `held` is the INCUMBENT (server-pinned to the un-walked verdict), never a walked sleeve.
  const heldPathHost = document.getElementById("heldPathHost");
  if (heldPathHost) {
    setHTML(
      heldPathHost,
      d.mode === "scenario" ? heldPathHtml(held ? held.sleeve : null, d.walkPath, d.ladder) : "",
    );
  }

  const foot = document.getElementById("dfFoot");
  if (foot) {
    // Directional held-pick knobs come from the served /api/danger-model block; the span is
    // omitted entirely if the model failed to load (no re-mirrored fallback constants).
    const dd = dangerModel && dangerModel.deriskDeadband;
    const rd = dangerModel && dangerModel.reriskDeadband;
    // Both timing clauses come from the pure seam (`rerisk-knobs.js`), each DERIVED from its own
    // served field — `reriskConfirm` for the streak, `reriskDwellDays` for the dwell. Gating both on
    // the confirm value alone was review finding 3: a `RERISK_DWELL_DAYS 0 → 1` re-arm (§5's ruled
    // first move) would have kept claiming there is no dwell clock while one blocked the rotation.
    const { sentence: gateSentence, chips: gateChips } = reriskGateCopy(dangerModel);
    const knobs = dangerModel
      ? ` · <span class="df-foot-note" title="Directional held-pick inertia (eyeball-tunable knobs, from /api/danger-model). Danger RISING ⇒ deadband ${dd} (de-risk fast to the calmest in-band leg, 1 close). FALLING/STABLE ⇒ deadband ${rd} (inertia - a leg danger-lower by &lt; ${rd} won't flip the hold).${gateSentence} Live direction is not yet on the /api wire.">knobs: de-risk Δ${dd} · re-risk Δ${rd}${gateChips}</span>`
      : "";
    // Scenario-only held clause: names the walk's delta + settle instead of the standing
    // held-rule gloss. `""` on the live path, on an absent walk and on a no-move walk — so the LIVE
    // footer wording is byte-unchanged (the `— most aggressive sleeve …` branch below is reached
    // verbatim whenever this is empty).
    // ⚠ Keep that gloss DIRECTION-AGNOSTIC — live direction is not on the wire. `pickHeld` windows
    // candidates by danger, then picks the LOWEST RISK RANK: de-risk (deadband 0) leaves a
    // singleton (= the calmest leg), re-risk (amber/2) lets a hotter leg keep the hold. The old
    // "calmest sleeve" wording stated only the de-risk half and read as a bug on re-risk closes.
    const heldWalkPhrase =
      d.mode === "scenario" ? heldPathFootPhrase(held ? held.sleeve : null, d.walkPath, d.ladder) : "";
    dfFootDefault = !band
      ? `<span class="df-foot-note">danger field unavailable - awaiting the next cron run</span>` // degraded: resolveField returned an empty field (stale pre-i7a cache mid-deploy); guard band before .lo/.hi
      : `dial band = r${band.lo}-r${band.hi}${band.label ? ` (${band.label})` : ""} · ` +
        (held
          ? `held <span class="held-mk">▶</span> <b>${esc(sleeveLabel(held.sleeve))}</b>` +
            (heldWalkPhrase || ` - most aggressive sleeve the danger buffer permits `)
          : `no in-band sleeve `) +
        `<span class="df-foot-note">(the sleeve auto-held for you &amp; pushed to ntfy on change)</span>` +
        knobs;
    // NOT title-free — `knobs` above carries a `title=` on `.df-foot-note` — but no ⓘ appears here:
    // #dfFoot lives inside #dangerField, which HELP_CARVEOUT_SELECTOR covers, so `needsGlyph` is
    // false for every host in this write and the knob tip is tap-readable off the TEXT (the capture
    // handler in help-bar.js) with or without the seam. The conversion is uniformity: one writer for
    // the whole file, already correct the day this host leaves the carve-out.
    setHTML(foot, dfFootDefault);
  }

  const grid = document.getElementById("dfGrid");
  if (grid) {
    // Re-apply the persistent open/closed sub-state to the freshly-rebuilt grid.
    grid.classList.toggle("show-rgn", dfShowRgn);
    grid.classList.toggle("show-attrib", dfShowAttrib);
    // Mark the held row as attribution-capable so the delegated #dangerField listener acts on it.
    const heldRow = attribHtml && grid.querySelector(".df-row.held");
    if (heldRow) heldRow.classList.add("has-attrib");
  }
}
/* ===================================================== VIEW B — STRUCTURE MAP
 * A second, SPATIAL rendering of the same per-leg danger score the ledger tints (computeField).
 * Rows = 6 region buckets, cols = 8 exposure buckets; each (rgn,sec) pair maps to at most one
 * leg (no collisions), so grid position alone identifies the sleeve — the sleeve name/props +
 * held read live in the cell TOOLTIP only (design §2/§3, no on-screen marker). Scaffold is
 * derived from constants (not by scanning data) so the 6×8 matrix is stable when all legs read
 * 0 (an all-calm live market — a flat green/blank map is CORRECT, not broken).
 *
 * The axes themselves live in the pure seam `structure-map-axes.js` (imported at the top of this
 * file) so `lab.structure-map.test.js` can pin them against `LEG_FIELD` — an out-of-axis leg is
 * dropped from the paint SILENTLY. The grid carries an
 * `EU` row and a `HiDiv` column, and `Income` is retained as a bucket no leg occupies. */

/** The ONE disclosure primitive on /lab — flip `hidden` on the body, mirror it into the button's
 *  `aria-expanded`, and swap the affordance glyph. Three callers (the danger ledger's
 *  `LEGEND ▸`, band-panel `.bp-fold` + `.bp-note-toggle`)
 *  share it so they cannot drift into three slightly different disclosures. Callers keep
 *  their OWN delegation (different stable hosts, different target resolution); only the state flip
 *  is shared. */
function toggleDisclosure(btn, body) {
  const open = body.hasAttribute("hidden");
  if (open) body.removeAttribute("hidden");
  else body.setAttribute("hidden", "");
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = btn.textContent.replace(open ? "▸" : "▾", open ? "▾" : "▸");
}

/** Once, in buildBench: wire the BAND panel's `+N calm ▸` fold toggles via event delegation on the
 *  stable #bandPanelHost (which survives the applyBoard innerHTML swap at renderBandPanel time), so
 *  a rebuild never loses or duplicates handlers — same pattern as buildDangerField. Clicking a
 *  `.bp-fold` reveals/hides its sibling `.bp-calm` block; the render stays pure (band-panel.js).
 *  The same delegation also drives `.bp-note-toggle` → the collapsed two-list
 *  footnote (`#bpNote`) and `.bp-floors-toggle` → the collapsed floors body (`#bpFloors`: the
 *  escalation sentence + the floor column). Both resolve their body by `aria-controls` rather than
 *  as a sibling — the note toggle is out of flow, and the floors body is opened by a button that is
 *  its previous sibling but must stay id-addressable for the `aria-controls` contract. */
export function buildBandPanel() {
  const host = document.getElementById("bandPanelHost");
  if (!host) return;
  // A disclosure pair is (button, the element it opens) — resolved by `aria-controls` when the button
  // carries one (note footnote, floors body), else as the calm fold sitting next to its block.
  const targetOf = (btn) => {
    if (btn.hasAttribute("aria-controls")) return document.getElementById(btn.getAttribute("aria-controls"));
    const calm = btn.nextElementSibling;
    return calm && calm.classList.contains("bp-calm") ? calm : null;
  };
  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".bp-fold, .bp-note-toggle, .bp-floors-toggle");
    if (!btn) return;
    const body = targetOf(btn);
    if (body) toggleDisclosure(btn, body);
  });
}

/** Once, in buildBench: the #structureMap wrapper + #smGridWrap already exist in the buildBench
 *  innerHTML and the map carries no persistent sub-state, so build* is a no-op — renderStructureMap
 *  paints the whole body every applyBoard. */
export function buildStructureMap(_d) {}

/** Every applyBoard: rewrite the structure-map grid from the once-computed field. */
export function renderStructureMap(field) {
  const wrap = document.getElementById("smGridWrap");
  if (!wrap) return;
  const { legRows, held } = field;
  // Index legs by (rgn, sec) — exactly one leg per pair (verified: no collisions).
  const byCell = {};
  for (const l of legRows) byCell[`${l.rgn}|${l.sec}`] = l;

  const head =
    `<th class="sm-corner"></th>` +
    SM_COLS.map((c) => `<th class="sm-col">${esc(c)}</th>`).join("");
  const body = SM_ROWS.map((rgn) => {
    const cells = SM_COLS.map((sec) => {
      const leg = byCell[`${rgn}|${sec}`];
      if (!leg) return `<td class="sm-cell empty"></td>`;
      const heldSuffix = held && leg.sleeve === held.sleeve ? " ◄ held" : "";
      const tip = `${sleeveLabel(leg.sleeve)} - ${leg.region} · ${leg.exposure} · ${leg.style} · danger ${leg.danger.toFixed(2)}${heldSuffix}`;
      return `<td class="sm-cell ${dangerClass(leg.danger)}" title="${esc(tip)}">${leg.danger.toFixed(2)}</td>`;
    }).join("");
    return `<tr><th class="sm-row">${esc(SM_ROW_LABEL[rgn])}</th>${cells}</tr>`;
  }).join("");
  // Every cell is a `[title]` host (the leg tip above), and this runs on every applyBoard.
  setHTML(wrap, `<table class="sm-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
}

/* ===================================================== VIEW C — RRG QUADRANT
 * Deliberately rough (user: "very cheap/rough View C"). Reads the shared resolveField(d) —
 * places each of the 9 legs as a CSS-absolute boxed NAME in a square box: x = own-danger (left→right),
 * y = momentum (bottom = worsening ▼, top = improving ▲). Name-text tint = dangerClass (hue = danger
 * only, §4). Band-candidate legs (risk ∈ band) get a ring; the held leg a ▶. No animation,
 * trails, zoom, hover-drilldown, or quadrant-fill colours. Built once with buildDangerField. */
/** Once, in buildBench: the #rrgQuadrant wrapper already exists in the buildBench innerHTML.
 *  renderQuadrant repaints the whole body every applyBoard, so the per-leg dot-cycle listener is
 *  delegated ONCE on the stable #rrgQuadrant here — it survives every innerHTML swap. */
export function buildQuadrant(_d) {
  const box = document.getElementById("rrgQuadrant");
  if (box) box.addEventListener("click", onQuadrantClick);
}

/** Scenario-only per-leg momentum dot-cycle: • 0 → ▲ +1 → ▼ −1 → • 0. Mutates scnMomentum and
 *  re-renders the quadrant from the cached lastField/lastD — no refetch (momentum is pure client
 *  input in scenario). Live mode has no clickable legs, so a stray click is a no-op. */
function onQuadrantClick(e) {
  if (!lastD || lastD.mode !== "scenario") return;
  const leg = e.target.closest(".rrg-leg");
  if (!leg || !leg.dataset.sleeve) return;
  const cur = scnMomentum[leg.dataset.sleeve] ?? 0;
  scnMomentum[leg.dataset.sleeve] = cur === 0 ? 1 : cur === 1 ? -1 : 0;
  if (lastField) renderQuadrant(lastField, lastD);
}

/** Every applyBoard: rewrite the quadrant from the once-computed field. */
export function renderQuadrant(field, d) {
  const box = document.getElementById("rrgQuadrant");
  if (!box) return;
  const { legRows, band, held } = field;
  // Momentum is mode-aware (§"Scenario momentum = manual per-leg input"): live reads the server
  // history-based legRows[].momentum (shipped only on the `?hist=20` load); scenario reads the
  // manual scnMomentum knob the user dot-cycles (deterministic scenario path carries no history,
  // so momentum is a declared client input — honest, stationary, X⇄Y independent).
  const scn = d.mode === "scenario";
  const momOf = (l) => (scn ? (scnMomentum[l.sleeve] ?? 0) : (l.momentum != null ? l.momentum : 0));
  // Position each leg, then de-collide LABELS (dots stay data-honest): in a calm/cold-start
  // market many legs land on danger≈0 / momentum≈0, so their labels would stack unreadably.
  // Global 1-D declutter: sort by dot-Y, push each label down to keep LABEL_GAP, then clamp
  // the whole stack into [Y_MIN, Y_MAX] so none escape the box top/bottom edge. Height is the
  // fixed 360px box (CSS), so px math here is stable even when the box shrinks in width.
  const H = 360, LABEL_GAP = 14, Y_MIN = 6, Y_MAX = 352;
  const pts = legRows.map((l) => ({
    l,
    left: Math.round(l.danger * 100),
    dotY: (1 - (momOf(l) + 1) / 2) * H, // px; momentum +1→top(0) … −1→bottom(H)
  }));
  const order = [...pts].sort((a, b) => a.dotY - b.dotY);
  let prev = -Infinity;
  order.forEach((p) => {
    p.labelY = Math.max(p.dotY, prev + LABEL_GAP); // greedy min-gap, pushing down
    prev = p.labelY;
  });
  if (order.length) {
    const under = Y_MIN - order[0].labelY;
    if (under > 0) order.forEach((p) => (p.labelY += under)); // clamp top edge always (the reported bug)
    const spill = order[order.length - 1].labelY - Y_MAX;
    if (spill > 0 && order[0].labelY - spill >= Y_MIN)
      order.forEach((p) => (p.labelY -= spill)); // clamp bottom too, but only if the stack still fits
  }
  // Per-leg danger×growth market mode, sourced exactly like the column. DISPLAY-ONLY,
  // encoded as a left colour STRIPE (marketModeClass) — a channel distinct from the danger-hue text and
  // the ring; the CVD-unsafe pair falls back to the hover title + x-position (USER).
  const amber = dangerModel?.legRagCuts?.amber ?? BAND_CUTS.amber;
  const dots = pts
    .map(({ l, left, dotY, labelY }) => {
      const dc = dangerClass(l.danger);
      const mode = marketMode(l.danger, l.growth, amber);
      const modeCls = marketModeClass(mode);
      const ring = band && l.risk >= band.lo && l.risk <= band.hi ? " ring" : "";
      const isHeld = held && l.sleeve === held.sleeve;
      // Per-leg mark IS the name: no dot, no glyph — a tight white
      // box holds the bold leg name, tinted by dangerClass, positioned at the decluttered
      // labelY. This de-clutters the calm-market pile better than a dot+offset-label pair.
      // Scenario legs are clickable (mirror the tile `clickable` affordance): a class the
      // delegated onQuadrantClick keys on, plus role/tabindex/aria-label for a11y. data-sleeve
      // identifies the leg's momentum knob. Live legs carry neither.
      const cls = `rrg-leg ${dc}${ring}${modeCls ? " " + modeCls : ""}${left > 50 ? " flip" : ""}`;
      const sleeve = esc(l.sleeve); // the KEY: data-sleeve keys the scnMomentum knob
      const name = esc(sleeveLabel(l.sleeve));
      const pos = posAttrs({ left, top: Number(((labelY / H) * 100).toFixed(1)) });
      const modeAttr = mode ? ` data-mode="${esc(mode)}"` : "";
      const title = `${name} · danger ${l.danger.toFixed(2)} · momentum ${momOf(l).toFixed(2)} · ${mode ?? "–"}`;
      const body = `${isHeld ? "▶ " : ""}${name}`;
      return scn
        ? `<span class="${cls} clickable" data-sleeve="${sleeve}" role="button" tabindex="0" aria-label="${name} - click to cycle momentum ▲/•/▼"${pos}${modeAttr} title="${title}">${body}</span>`
        : `<span class="${cls}" data-sleeve="${sleeve}"${pos}${modeAttr} title="${title}">${body}</span>`;
    })
    .join("");
  const note = scn
    ? "x = own-danger · y = momentum - click a leg to set ▲/•/▼ (what-if input)"
    : "x = own-danger · y = momentum (▼ worsening / improving ▲)";
  // Mode legend: a swatch per danger×growth mode + the honesty line. The mode's danger split is the
  // SERVED amber cut, NOT the chart's centre vrule (drawn at danger 0.5), so a "high-danger" mode can sit
  // left of the centre line. State it so the stripe colour is not misread as flipping at the vrule.
  const modeLegend =
    `<p class="rrg-modes">mode (danger×growth): ` +
    Object.values(MARKET_MODES)
      .map((m) => `<span class="rrg-mode-key"><i class="rrg-swatch ${marketModeClass(m)}"></i>${m}</span>`)
      .join("") +
    `</p>` +
    `<p class="rrg-mode-note">⚠ mode danger split = amber ${amber.toFixed(3)} - left of the centre line (danger 0.5); the stripe colour is the mode, not the vrule.</p>`;
  const quadHtml =
    `<h2 class="rrg-title sec-tip"${secTip("rotationQuadrant")}>Rotation quadrant - View C</h2>` +
    `<p class="rrg-note">${note} · ring = band candidate · ▶ = held</p>` +
    modeLegend +
    `<div class="rrg">` +
    `<div class="rrg-vrule"></div><div class="rrg-hrule"></div>` +
    `<span class="rrg-axis ax-t">▲ improving</span>` +
    `<span class="rrg-axis ax-b">▼ worsening</span>` +
    `<span class="rrg-axis ax-l">calm</span>` +
    `<span class="rrg-axis ax-r">dangerous</span>` +
    dots +
    `</div>`;
  setHTML(box, quadHtml);
}

/* ===================================================== SCOREBOARD (D9 live gates)
 * A compact card below the other sections: the two D9 gates as visually SEPARATE
 * verdicts — (a) ulcer index, (b) override count — plus a maxDD/Calmar/recovery strip
 * (strategy vs yardstick) and the two verbatim honesty labels (proxy yardstick + the
 * measuring-window statement). Everything arrives precomputed on the LIVE payload
 * (d.scoreboard, src/scoreboard.ts); scenario responses carry no scoreboard field, so
 * the section drops out entirely there. Markup lives in scoreboard-card.js (a pure
 * seam, like tile-members.js) so lab.scoreboard.test.js pins it without jsdom. */

/** Once, in buildBench: the #scoreboard wrapper already exists in the buildBench
 *  innerHTML; no delegated listeners needed (mirrors buildStructureMap). */
export function buildScoreboard(_d) {}

/** Every applyBoard: repaint the card from the server-computed d.scoreboard. A payload
 *  with no scoreboard field (scenario mode / a stale pre-scoreboard cached payload)
 *  hides the section via the `hidden` attr — independent of the visbar's per-mode
 *  .is-hidden toggle, so a user "show scoreboard" chip can't resurrect it in scenario. */
export function renderScoreboard(sb) {
  const el = document.getElementById("scoreboard");
  if (!el) return;
  const html = scoreboardCardHtml(sb);
  el.hidden = html === null;
  const body = document.getElementById("sbBody");
  if (body) {
    // `sb-na`'s reason is a `[title]` host (scoreboard-card.js) and this repaints every applyBoard.
    setHTML(body, html ?? "");
  }
}

/** Fixed tier split (mirrors t1dial.ts LEADING/COINCIDENT — derived there from the
 *  lead-time super-groups): LEADING = EARLY-WARN (credit, rates; the valuation stub is excluded
 *  from the dial) SELECTS the band; COINCIDENT = STRESS-NOW (volatility ⊇ complacency, cross-asset =
 *  old dispersion+flight) + the CONFIRMING trend confirmer POSITIONS the ● inside it. */
const ATTRIB_TIERS = {
  leading: ["credit", "rates"],
  coincident: ["volatility", "cross-asset", "trend"],
};
const CHIP_LABEL = { credit: "credit", rates: "rates", volatility: "vol", "cross-asset": "x-asset", trend: "trend" };

/** glyph + colour class + state label for a family's confirmed state. */
function stateGlyph(state) {
  if (state === "RED") return { g: "●", cls: "cs-red", lab: "RED" };
  if (state === "AMBER") return { g: "◐", cls: "cs-amber", lab: "AMBER" };
  return { g: "·", cls: "cs-calm", lab: "" };
}

/** The dial's attribution HTML (a string embedded in the ledger's
 *  held-row expandable). Two tier-labeled chip
 *  rows (LEADING selects the band / COINCIDENT positions the ●), then the dial's band→depth
 *  "why this rung" line, then the PICK trace — which leg the band's window actually held, and why
 *  that leg is not the ●'s leg. Chips are sourced from d.globalFamilies (the panel the dial
 *  aggregates) so global-only legs surface; falls back to the US families panel.
 *
 *  `held` + `legRows` are threaded in for the pick trace ONLY ([USER] 2026-09-06): the reveal used
 *  to stop at `● rung N (leg)`, one line above a ledger row tagged `rN ◄ held` carrying a DIFFERENT
 *  number, and said nothing about the step between them. Both are already resolved at the call site
 *  (`applyBoard`), so this READS the served field — it derives no danger and re-picks nothing. */
function buildAttribHtml(d, t1, ladder, held, legRows) {
  if (!t1) return "";
  const panel = d.globalFamilies && d.globalFamilies.length ? d.globalFamilies : d.families;
  const byKey = Object.fromEntries((panel || []).map((f) => [f.key, f]));
  const chip = (key, positionMode) => {
    const f = byKey[key];
    const name = CHIP_LABEL[key] ?? key;
    if (positionMode) {
      // COINCIDENT row: a firing family lights in its OWN state colour (◐ amber / ● red) —
      // it nudges the ● within the band; GREEN/non-firing shows a dimmed ·. Mirrors the board.
      const sg = stateGlyph(f ? f.state : null);
      const firing = !!(f && f.firing);
      return `<span class="chip-f"><span class="cn">${name}</span> <span class="${firing ? sg.cls : "cs-calm"}">${firing ? sg.g : "·"}</span></span>`;
    }
    const sg = stateGlyph(f ? f.state : null);
    return `<span class="chip-f"><span class="cn">${name}</span> <span class="${sg.cls}">${sg.g}${sg.lab}</span></span>`;
  };
  const sep = ' <span class="sep">·</span> ';
  const leadRow = ATTRIB_TIERS.leading.map((k) => chip(k, false)).join(sep);
  const coincidentRow = ATTRIB_TIERS.coincident.map((k) => chip(k, true)).join(sep);

  const nLead = t1.leadingFiring;
  const leg = esc(sleeveLabel(ladder[t1.targetRung - 1] ?? ""));
  // Graded systemic bump: cross-asset AMBER/RED beside another firing family adds
  // +0.5/+1 to the rung; hidden at 0 (an isolated cross-asset move is a rotation, not systemic).
  const bump =
    t1.systemicBump > 0
      ? ` <span class="sep">·</span> <b>cross-asset systemic</b> +${t1.systemicBump}`
      : "";
  // US-tech downside-breadth confirmer: a within-band deepener over {SMH,NVDA,QQQ} (≥2-of-3
  // floor). Surfaced beside the coincident depth since it folds into the SAME within-band position.
  const tech =
    t1.techConfirmerP > 0
      ? ` <span class="sep">·</span> <b>US-tech downside</b> ${t1.techConfirmerP.toFixed(2)}`
      : "";
  const why =
    `<p class="attrib-why"><b>${nLead}</b> leading ${nLead === 1 ? "family fires" : "families fire"} (credit, rates) → band ` +
    `<b>rungs ${t1.band.lo}-${t1.band.hi}</b>; coincident depth <b>${t1.positionP.toFixed(2)}</b> ` +
    `(${t1.coincidentFiring} of 3)${tech}${bump} → <span class="t1k">● rung ${t1.targetRung}</span>${leg ? ` (${leg})` : ""}.</p>`;
  // THE PICK TRACE ([USER] 2026-09-06, condensed 2026-09-06) — the step the reveal used to skip:
  // band window → candidate legs → the one held. The `why` line above ends on `● rung N (leg)` and
  // sits directly over a ledger row tagged `rN ◄ held` carrying a DIFFERENT number; they are
  // different objects (a rung is a leg's fixed SEAT on the 1..9 ladder, the band is the window of
  // seats today allows, the ● is the dial's target inside it) and selection reads the WINDOW, never
  // the ●. Read off the SERVED field (`legRows`, `field.held`), never re-derived: the in-band test
  // mirrors `pickHeld`'s IN-BAND set (`risk ∈ [lo,hi]`, danger-deadband.ts) and the numerals are the served `danger` ×100, the rows' Own-Danger numeral. It stops THERE by design: `pickHeld` narrows that set again to
  // `effDanger ≤ dMin + deadband`, and neither the deadband's direction nor the post-concentration
  // `effDanger` it compares is on the /api wire, so the FE lists the WINDOW and names the held leg
  // rather than pretending to reproduce the buffer. Listed by RUNG, not by danger — the list is the band's window read
  // left-to-right, and the pick's final key is `risk`, not danger.
  //
  // ⚠ The sentence is DIRECTION-AGNOSTIC by requirement, and never says "calmest" ([USER]
  // 2026-09-06 — the same defect #dfFoot's gloss already carries a warning about). `pickHeld`
  // windows candidates to `effDanger ≤ dMin + deadband` and then takes the LOWEST RISK inside that
  // buffer; only the de-risk deadband (0) collapses that to the danger argmin, and the FE cannot
  // tell which deadband fired — live direction is not on the /api wire. So "calmest" would state
  // the de-risk half only and read as a bug on every re-risk close, even on the days it happens to
  // name the right leg.
  // Absent field (degraded load, no held) ⇒ the trace drops and the one-line rung note still renders.
  const cand = (legRows || [])
    .filter((l) => l.risk >= t1.band.lo && l.risk <= t1.band.hi)
    .sort((a, b) => a.risk - b.risk);
  const dNum = (l) => Math.round(l.danger * 100);
  let pickTrace = "";
  if (held && cand.length) {
    const heldRow = cand.find((l) => l.sleeve === held.sleeve);
    const list = cand
      .map(
        (l) =>
          `<span class="${l.sleeve === held.sleeve ? "t1k" : ""}">${esc(sleeveLabel(l.sleeve))} r${l.risk} ${dNum(l)}</span>`,
      )
      .join(' <span class="sep">·</span> ');
    const rule = heldRow
      ? `<b>${esc(sleeveLabel(held.sleeve))}</b> held - the most aggressive leg the danger buffer permits`
      : `<b>${esc(sleeveLabel(held.sleeve))}</b> held from the prior close`;
    pickTrace = `In rungs ${t1.band.lo}-${t1.band.hi}: ${list} → ${rule}. `;
  }
  // One clause, kept ON SCREEN rather than left to the `risk` column's `title=` — a tooltip is
  // hover-only, i.e. invisible on the phone this reveal was condensed for.
  const rungFoot =
    `<p class="attrib-why attrib-why-foot">${pickTrace}` +
    `A rung is a seat (r1 most aggressive → r9 cash); the <span class="t1k">●</span> is the dial's ` +
    `target inside the band, not the position.</p>`;

  // `.attrib-fit` is the mobile clamp — see `fitAttribWidth` / `.attrib-fit` in lab.css.
  return (
    `<div class="attrib-fit">` +
    `<div class="attrib-tiers">` +
    `<div class="attrib-row"><span class="tier-label">LEADING <span class="tl-sub">band ${t1.band.lo}-${t1.band.hi}</span></span>${leadRow}</div>` +
    `<div class="attrib-row"><span class="tier-label">COINCIDENT <span class="tl-sub">position ●</span></span>${coincidentRow}</div>` +
    `</div>` +
    why +
    rungFoot +
    `</div>`
  );
}

/* ------------- state glue for lab.js (importers cannot assign module lets) ------------- */

/** Entering scenario starts the manual momentum knob flat (called by lab.js setMode). */
export function resetScnMomentum() {
  scnMomentum = {};
}

/** Cache the last resolved field + payload (applyBoard) for the quadrant dot-cycle re-render. */
export function cacheLast(field, d) {
  lastField = field;
  lastD = d;
}

/** Replay caches only the payload (applyReplay) — no field is resolved on that path. */
export function cacheLastD(d) {
  lastD = d;
}
