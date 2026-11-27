/**
 * Ledger two-pillar idiom text-builders (repurposed from the retired `subDangerText` tooltip).
 * Pure module (no DOM) so vitest collects the selection logic — same seam idiom as tile-members.js.
 *
 * These re-express the server-sent EW/SN pillar pair (`legRows[].subDangers`) + the confirmed
 * `regime` field into the four independently-prunable ledger idioms. NO client engine math: the
 * aggregation is server-side; these helpers only map value→band/width/glyph.
 */

import { posAttrs } from "./inline-pos.js";

/** The FE band-colour seam (was lab.js `dangerClass`), relocated here so every idiom + its tests
 *  share ONE threshold source. Hue = danger band only (design §4). The cuts are SERVED on the wire
 *  (`/api/danger-model` → `legRagCuts`, mirror of the server `DANGER_CUTS`): `lab.js` calls
 *  `setBandCuts` once at load so the FE colours agree with the server and a USER retune of the
 *  leg-RAG cuts propagates automatically. The default below MATCHES `DANGER_CUTS` so FE and server
 *  agree even before the fetch resolves. The idioms colour from these cuts only; the row's named
 *  `regime` chip comes pre-confirmed from the server, so the FE never re-quantizes.
 *
 *  ⚠ A `DANGER_CUTS` retune and this mirror MUST land in ONE commit: a lagging mirror paints the FE
 *  in the OLD bands for every viewer whose `/api/danger-model` fetch has not resolved. */
export const BAND_CUTS = { amber: 0.3362, red: 0.5435 };
let activeCuts = BAND_CUTS;
/** Adopt the server-sent leg-RAG cuts (from `/api/danger-model`). A missing/malformed payload keeps
 *  the `BAND_CUTS` default (which mirrors `DANGER_CUTS`) — the FE never diverges silently. */
export function setBandCuts(cuts) {
  activeCuts =
    cuts && typeof cuts.amber === "number" && typeof cuts.red === "number" ? cuts : BAND_CUTS;
}
/** Pure: colours `v` by `cuts` (defaults to the active served cuts). Pass explicit `cuts` in tests. */
export function bandClass(v, cuts = activeCuts) {
  return v >= cuts.red ? "r" : v >= cuts.amber ? "a" : "g";
}

/** The FE mirror of the server's `pillarValue` narrowing seam (`src/danger-engine.ts`).
 *  A served pillar is a TAGGED UNION (`PillarScore`): `{kind:"scored", value}` |
 *  `{kind:"uncomparable", reason:"not-live"}`. This is the ONE place the FE unwraps it —
 *  every idiom below goes through here rather than re-typing the `kind` check, so a third arm is one
 *  edit. Tolerates `null`/`undefined` (an older cached payload / a scenario row with no pillar) by
 *  returning `null`, exactly as the pre-6.5 `number | null` wire behaved. */
export function pillarValue(p) {
  return p && p.kind === "scored" ? p.value : null;
}

/** Attribute escaper — local copy, matching the `band-panel.js` / `scoreboard-card.js` precedent
 *  (each markup seam carries its own so no seam depends on another's internals). */
function escAttr(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/** The clause appended when the bar is AT its axis maximum (`pillarValue(pillar) >= BAR_FULL_SCALE`),
 *  BEFORE the caller's `clauses` tail. Carries no leg / family / pillar PROPER NAME, so no name-sync duty. */
export const CLAMP_CLAUSE = " - axis maximum: further danger cannot be drawn; read the number";

/** Named regime chip label from the server-confirmed 2×2 state. Unknown/absent → "" so the
 *  caller omits the chip (never renders a bogus state). */
const REGIME_LABEL = { calm: "CALM", deter: "DETER", stress: "STRESS", recov: "RECOV" };
export function regimeChipLabel(regime) {
  return REGIME_LABEL[regime] || "";
}

/** One pillar mini-bar: width% (0–100, clamped) + its OWN band (single-hue intensity,
 *  colourblind-safe). A null pillar ⇒ width 0 / band `na` (absent — empty framed track).
 *  Calm rendering: a MEASURED low value never disappears — the fill is floored at a small sliver
 *  (`CALM_SLIVER_PCT`) so calm reads as "measured and low", not absence. */
export const CALM_SLIVER_PCT = 3;

/** The bar's 100%-width point (share scale ∈ [0,1]); `CLAMP_CLAUSE` fires at it. DISPLAY-ONLY — `bandClass`
 *  reads the raw value against the raw cuts. */
export const BAR_FULL_SCALE = 1;

export function pillarBar(value, cuts = activeCuts) {
  if (value == null) return { pct: 0, band: "na" };
  const pct = Math.max(CALM_SLIVER_PCT, Math.min(100, Math.round((value / BAR_FULL_SCALE) * 100)));
  return { pct, band: bandClass(value, cuts) };
}

/** One ledger pillar-bar as markup (`renderPillarBars` composes it twice): `not-live` → the empty framed
 *  track (`titles.na`); `scored` → the band fill, + `CLAMP_CLAUSE` at the axis maximum. `clauses` (falsy
 *  entries drop out) append to either branch's title — append there, never concatenate into `titles`. */
export function pillarBarHtml(lbl, pillar, opts = {}) {
  const { ticksHtml = "", clauses = [], titles = {}, cuts = activeCuts } = opts;
  const raw = pillarValue(pillar);
  const { pct, band } = pillarBar(raw, cuts);
  const extra = (Array.isArray(clauses) ? clauses : []).filter(Boolean).join("");
  const wrap = (title, inner) =>
    `<span class="lg-bar" title="${escAttr(`${title}${extra}`)}">` +
    `<span class="lg-bar-lbl">${escAttr(lbl)}</span>${inner}</span>`;
  if (band === "na") return wrap(titles.na, `<span class="lg-bar-track">${ticksHtml}</span>`);
  // The clamp threshold is `BAR_FULL_SCALE` ITSELF — never a second literal — compared against the
  // RAW value, not the display pct.
  const title = titles[band](String(Math.round(raw * 100))) + (raw >= BAR_FULL_SCALE ? CLAMP_CLAUSE : "");
  return wrap(
    title,
    `<span class="lg-bar-track">${ticksHtml}<span class="lg-bar-fill ${band}"${posAttrs({ width: pct })}></span></span>`,
  );
}

/** Band-cut tick positions for the bar tracks: hairline marks at the ACTIVE amber/red cuts (served
 *  `legRagCuts`, never hard-coded literals) — the decision-relevant marks.
 *
 *  Positions are on the SAME rescaled axis as `pillarBar`'s fill (`BAR_FULL_SCALE`),
 *  or the hairlines would no longer mark where the fill crosses the band. Still derived from the
 *  passed/served cuts — a `DANGER_CUTS` retune moves them for free *within the axis* (cut ≤
 *  `BAR_FULL_SCALE`). Past that the pct is clamped to 100, matching `pillarBar`'s own
 *  `Math.min(100, …)`: the hairline PINS to the axis end instead of being emitted at `left:105%`
 *  and silently clipped away by `.lg-bar-track`'s `overflow: hidden` (`lab.html`). */
export function bandTicks(cuts = activeCuts) {
  return [
    { pct: Math.min(100, (cuts.amber / BAR_FULL_SCALE) * 100), band: "a" },
    { pct: Math.min(100, (cuts.red / BAR_FULL_SCALE) * 100), band: "r" },
  ];
}

/** Speed-arrow intensity cuts (eyeball-tunable): |roc| ≥ 0.02 / 0.05 / 0.10 in raw pillar units
 *  (2/5/10 points ×100) for levels 1/2/3. SHARED by BOTH pillars: the cuts live on the
 *  squared-pillar [0,1] scale `danger` is read on, so only the *cadence*
 *  differs per pillar (SN 5 closes / EW `EW_ROC_LOOKBACK = 20`), never the cut scale. */
export const SN_ROC_CUTS = [0.02, 0.05, 0.1];

/** Per-pillar arrow COPY (the only thing that varies between pillars — the cuts are shared).
 *  `window` names the served ROC's lookback; the 7 title builders take the pre-formatted delta. */
export const SN_SPEED_COPY = {
  window: "the last 5 closes",
  flat: (d) => `stress steady - ${d}; no meaningful change this week`,
  up: [
    (d) => `stress creeping up - ${d}; danger drifting higher for this leg`,
    (d) => `stress climbing - ${d}; danger building at pace for this leg`,
    (d) => `stress spiking - ${d}; danger accelerating fast into this leg`,
  ],
  down: [
    (d) => `stress easing - ${d}; danger drifting off this leg`,
    (d) => `stress falling - ${d}; pressure coming off this leg at pace`,
    (d) => `stress draining - ${d}; danger clearing fast off this leg`,
  ],
};

/** EW's copy. The lookback is EW's OWN (`EW_ROC_LOOKBACK = 20` ≈ 1 month; see src/danger-engine.ts).
 *  The copy's "this month" wording rides an open re-decide of that lookback. */
export const EW_SPEED_COPY = {
  window: "the last 20 closes",
  flat: (d) => `early-warn steady - ${d}; no meaningful change this month`,
  up: [
    (d) => `early-warn creeping up - ${d}; forward-looking gauges drifting higher for this leg`,
    (d) => `early-warn climbing - ${d}; forward-looking gauges building at pace for this leg`,
    (d) => `early-warn spiking - ${d}; forward-looking gauges firing up fast for this leg`,
  ],
  down: [
    (d) => `early-warn easing - ${d}; forward-looking gauges drifting off this leg`,
    (d) => `early-warn falling - ${d}; pressure coming off this leg's forward gauges at pace`,
    (d) => `early-warn draining - ${d}; forward-looking gauges clearing fast off this leg`,
  ],
};

/** Pillar-agnostic speed arrow from a served raw-pillar ROC (positive = worsening).
 *  7 states: 3 up levels (warm ramp, ↗/↑/⇈) + 3 down levels (cool ramp, ↘/↓/⇊) + flat (→);
 *  a missing/absent roc (scenario loads, degraded paths, pillar not live, cold-start rows whose
 *  t−N base was never OBSERVED) ⇒ NO arrow (`glyph: ""`). Titles are state-specific (active
 *  meaning + impact) — hence the per-pillar `copy`. */
export function speedArrow(roc, cuts = SN_ROC_CUTS, copy = SN_SPEED_COPY) {
  if (typeof roc !== "number" || Number.isNaN(roc)) return { glyph: "", cls: "", title: "" };
  const a = Math.abs(roc);
  const level = a >= cuts[2] ? 3 : a >= cuts[1] ? 2 : a >= cuts[0] ? 1 : 0;
  const pts = Math.round(roc * 100);
  const d = `${pts > 0 ? "+" : ""}${pts} (×100) over ${copy.window}`;
  if (level === 0) return { glyph: "→", cls: "s0", title: copy.flat(d) };
  if (roc > 0)
    return { glyph: ["↗", "↑", "⇈"][level - 1], cls: `w${level}`, title: copy.up[level - 1](d) };
  return { glyph: ["↘", "↓", "⇊"][level - 1], cls: `c${level}`, title: copy.down[level - 1](d) };
}

/** Thin pillar-bound aliases — the call sites read as the pillar they render. */
export const snSpeedArrow = (snRoc, cuts = SN_ROC_CUTS) => speedArrow(snRoc, cuts, SN_SPEED_COPY);
export const ewSpeedArrow = (ewRoc, cuts = SN_ROC_CUTS) => speedArrow(ewRoc, cuts, EW_SPEED_COPY);

/** EXOGENOUS weather glyph from G1's live confirmed state (the same wire the signal grid reads) +
 *  the served `field.exogenous.floor` for the title's impact number. EXO is not a pillar — a level
 *  glyph (▶ calm / ▲ elevated / ▲▲ red), never a magnitude bar.
 *
 *  ⚠ The GLYPH keys on G1 alone, but the engine's `gp` term is a weighted max over G1, OVX and BRENT
 *  (all at ×1.0). So the glyph is a G1 WEATHER READ, not a read-out of the term — an OVX-led shock
 *  can move every leg's danger while this glyph still shows `▶`. Widening it needs served per-member
 *  `gp` state, which the `/api/lab` field does not carry today.
 *
 *  ⚠ NOT a uniform overlay floor: each leg carries its OWN weighted oil danger; the served `floor`
 *  is the MINIMUM of those across the 9 legs — a true lower bound, less than what most legs carry.
 *
 *  `undefined` means G1 did NOT report (the FE member map omits an unobserved member, matching the
 *  server's `buildMemberState`). Same OUTCOME as calm (`▶`, no WTI danger claimed) but says so.
 *
 *  Both the calm and absent arms report WTI's weather and neither may claim the FAMILY is quiet —
 *  pinned with a negative arm in `sub-dangers.test.js`. */
export function exoGlyph(g1State, floor = 0) {
  if (g1State === undefined || g1State === null)
    return {
      glyph: "▶",
      band: "g",
      title:
        "WTI not reporting - this glyph reads WTI only; OVX is not shown here and may still be adding danger to every leg",
    };
  if (g1State === "lit")
    return {
      glyph: "▲▲",
      band: "r",
      title: `exogenous shock live - oil confirmed red; each leg carries its own weighted oil danger, at least ${floor}`,
    };
  if (g1State === "elev")
    return {
      glyph: "▲",
      band: "a",
      title: `exogenous shock building - oil confirmed amber; each leg carries its own weighted oil danger, at least ${floor}`,
    };
  return {
    glyph: "▶",
    band: "g",
    title:
      "WTI calm - this glyph reads WTI only; OVX is not shown here and may still be adding danger to every leg",
  };
}

/** Few-style bullet model on a shared 0–1 scale: filled bar = SN, `|` tick = EW. The band
 *  ladder shading derives from the SAME BAND_CUTS so the OK/WATCH/WARN backdrop and the bar/tick
 *  colours agree. Values clamped to [0,100]%; a null pillar ⇒ bar width 0 / tick null (absent). */
/** The band-ladder backdrop for the bullet graph, derived from `cuts` (defaults to the active
 *  served cuts) so the shading tracks a USER retune in lock-step with the bar/tick colours. */
export function bulletBands(cuts = activeCuts) {
  return [
    { cls: "g", to: cuts.amber * 100 },
    { cls: "a", to: cuts.red * 100 },
    { cls: "r", to: 100 },
  ];
}
export function bulletModel(subDangers, cuts = activeCuts) {
  const sn = subDangers ? pillarValue(subDangers.stressNow) : null;
  const ew = subDangers ? pillarValue(subDangers.earlyWarn) : null;
  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));
  return {
    snPct: sn == null ? 0 : clampPct(sn),
    snBand: sn == null ? "na" : bandClass(sn, cuts),
    tickPct: ew == null ? null : clampPct(ew),
    tickBand: ew == null ? "na" : bandClass(ew, cuts),
    bands: bulletBands(cuts),
  };
}
