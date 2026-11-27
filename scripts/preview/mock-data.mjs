// Faithful mock of the read API for the local dashboard preview (no live
// Supabase / FRED needed). Shapes mirror src/api/types.ts + the renderers in
// public/app.js. Default scenario is "all calm" (every channel score 0, OK) so
// the preview matches the common production state; override via scenario knobs.
//
// ⚠ **`scripts/preview/mock-data.mjs` serves `legRagCuts {0.129, 0.38}`, not `BAND_CUTS`, and ignores
// `?s=`** — a headless `/lab` measurement reads the MOCK's cuts unless `preview:live` + the local stack.
// It also carries its own `LEG_FIELD`/`MEMBER_WEIGHT` copies, outside `tsc`.

// NAMES ARE IMPORTED, never restated here (2026-07-24, name-duplication backlog stage 2): every
// `label` on a fixture row comes from the registry via `labelOf()`, and `MEMBER_LABEL` is the real
// derived table. `npm run preview` — and every script that spawns this server — runs under `tsx`,
// so src's `.js` specifiers resolve. Values/dates/states/weights below stay hand-authored.
// Explicit `.ts` specifiers (the one place the repo's `.js`-specifier convention does NOT apply):
// this file is never deployed, and vite/vitest — which loads it via mock-gates-parity.test.js —
// won't do the `.js`→`.ts` fallback for a `.mjs` importer. Same form as that test's `gates.ts` import.
import { ALL_INDICATORS } from "../../src/registry.ts";
import { MEMBER_LABEL, CLUSTERS, RERISK_CONFIRM, RERISK_DWELL_DAYS } from "../../src/danger-ladder.ts";
// The danger-model KNOBS are IMPORTED, never hand-mirrored (2026-08-07 review finding 5): the
// hand-typed copies had drifted (concThreshold 0.3 vs 0.2412, legRagCuts.amber 0.129 vs 0.2412) and
// `reriskConfirm: 2` actively drove the preview down `public/lab.js`'s RETIRED-gate branch, so
// `npm run preview` rendered the pre-2026-08-07 asymmetry as current. Same rule the `thresholds`
// helper above already follows: take the reachable import and the drift class disappears.
import {
  CONC_THRESHOLD,
  CONC_WEIGHT,
  DANGER_CUTS,
  DERISK_DEADBAND,
  RERISK_DEADBAND,
  PILLAR_MEMBER_IDS,
} from "../../src/danger-engine.ts";
import { SLOW_INDICATOR_IDS } from "../../src/registry-price.ts";
import { US_FAMILIES as REGISTRY_FAMILIES, CARD_ONLY_GROUPS } from "../../src/families.ts";
import { LEG_CHART_ID } from "../../public/leg-chart.js";
import { EXPOSURE_THRESHOLDS, computeExposure } from "../../src/exposure.ts";

/** The registry's official short name for an id. Throws on an unknown id, so a typo in this fixture
 *  fails loudly at import instead of rendering a nameless card. */
function labelOf(id) {
  const hit = ALL_INDICATORS.find((i) => i.id === id);
  if (!hit) throw new Error(`mock-data: no registry indicator with id "${id}"`);
  return hit.label;
}

/** The registry's `series` id for an id — informational metadata mirrored onto the SLOW/PENSION/
 *  BOTTOM preview metas (single-sourced, stage 3 name-dup backlog: the hand-typed "VIX"/"VIX3M"
 *  literals had drifted from the registry's "^VIX"/"^VIX3M"). Throws on an unknown id. */
function seriesOf(id) {
  const hit = ALL_INDICATORS.find((i) => i.id === id);
  if (!hit) throw new Error(`mock-data: no registry indicator with id "${id}"`);
  return hit.series;
}

/** The registry's `thresholds` for an id — the cut pair the preview's detail chart bands off.
 *  IMPORTED, never restated: a hand-typed pair here rots the moment its registry source is retuned,
 *  silently and with every suite green (one did). Taking the reachable import over a
 *  guard dissolves the drift class AND keeps the preview's fidelity — a blanked `thresholds: {}` row
 *  falls to buildChartMock's context-only branch and paints unbanded where prod paints bands.
 *  Returns a COPY so a fixture tweak can never write through to the registry. Throws on an unknown id. */
function thresholdsOf(id) {
  const hit = ALL_INDICATORS.find((i) => i.id === id);
  if (!hit) throw new Error(`mock-data: no registry indicator with id "${id}"`);
  return { ...hit.thresholds };
}

/** The registry derived-descriptor axis title for an id (the detail chart's secondary-axis label).
 *  Single-sourced from the registry so the preview's axis titles can't drift (F5's had). The mock's
 *  hand-authored kind/window/amber/red/unit stay — only the NAME comes from src. Throws if the id
 *  has no derived descriptor. */
function derivedLabelOf(id) {
  const hit = ALL_INDICATORS.find((i) => i.id === id);
  if (!hit?.derived) throw new Error(`mock-data: id "${id}" has no registry derived descriptor`);
  return hit.derived.label;
}

/** The families.ts label for a family key. Single-sourced: the mock's per-family ids/note/desc/
 *  awaiting stay hand-authored (a curated scenario), only the NAME comes from src (valuation's had
 *  drifted, "Valuation / Bubble" vs "Valuation"). Throws on an unknown key. */
function familyLabelOf(key) {
  const hit = REGISTRY_FAMILIES.find((f) => f.key === key);
  if (!hit) throw new Error(`mock-data: no families.ts family with key "${key}"`);
  return hit.label;
}

/** Attach the registry label to a hand-authored fixture row (id first so the key order is stable).
 *  A row that restates its own `label` is rejected rather than merged: this stage deleted the name
 *  mirrors instead of pinning them, so this throw IS the guard against one copy-pasted row quietly
 *  re-opening the class. (Spreading `rest` last would let the hand-typed string shadow the
 *  registry's with no error — the exact failure mode, inverted.) */
const withLabel = ({ id, ...rest }) => {
  if ("label" in rest) throw new Error(`mock-data: row "${id}" restates a label — names come from the registry`);
  return { id, label: labelOf(id), ...rest };
};

/** Like withLabel, but ALSO attaches the registry `series` id (the SLOW/PENSION/BOTTOM metas carry
 *  one). Rejects a row that restates either — both are names single-sourced from the registry. */
const withLabelSeries = ({ id, ...rest }) => {
  if ("label" in rest) throw new Error(`mock-data: row "${id}" restates a label — names come from the registry`);
  if ("series" in rest) throw new Error(`mock-data: row "${id}" restates a series — the series id comes from the registry`);
  return { id, label: labelOf(id), series: seriesOf(id), ...rest };
};

// The shipped indicator set (mirror of src/registry-fred.ts INDICATORS).
const INDICATORS = [
  { id: "F1", channel: "FIN", unit: "%", base: 3.5, thresholds: { amberLevel: 4.5, redLevel: 6.0, amberVelocity: 1.0, redVelocity: 1.75 } },
  { id: "F2", channel: "FIN", unit: "%", base: 1.1, thresholds: { amberLevel: 1.5, redLevel: 2.0, amberVelocity: 0.4, redVelocity: 0.7 } },
  { id: "F3", channel: "FIN", unit: "", base: 0.1, thresholds: { amberLevel: 0.5, redLevel: 1.0 } },
  // No `amberLevel` — mirrors the live registry since R1 retired its fixed amber cut (2026-08-30).
  { id: "R1", channel: "RATE", unit: "%", base: 1.0, direction: "LOW", thresholds: { redLevel: 0.0 } },
  { id: "R2", channel: "RATE", unit: "%", base: 4.2, thresholds: { amberVelocity: 0.4, redVelocity: 0.7 } },
  { id: "R3", channel: "RATE", unit: "%", base: 4.0, thresholds: { amberVelocity: 0.35, redVelocity: 0.6 } },
  { id: "R4", channel: "RATE", unit: "%", base: 1.8, thresholds: { amberVelocity: 0.3, redVelocity: 0.5 } },
  { id: "R5", channel: "COINCIDENT", unit: "", base: 15, thresholds: { amberLevel: 25, redLevel: 35 } },
  // GEO + CONTEXT + EBP cards (mirror of src/registry-*.ts G1/F4/F5/NVDA/EBP). The
  // bespoke scorers carry `thresholds: {}` + a `derived` descriptor that drives the
  // detail chart's SECONDARY axis + bands (mirror of registry.ts; band values mirror
  // the scorer constants). EBP is FIN but a monthly COINCIDENT confirmer (level-only,
  // HIGH); its series here is daily-spaced (the front-end is cadence-agnostic).
  { id: "G1", channel: "GEO", unit: "", base: 75, thresholds: {},
    derived: { kind: "return", window: 20, amber: 0.2, red: 0.4, label: derivedLabelOf("G1"), unit: "%" } },
  { id: "F4", channel: "CONTEXT", unit: "", base: 260, thresholds: {},
    derived: { kind: "return", window: 126, amber: -0.15, red: -0.25, label: derivedLabelOf("F4"), unit: "%" } },
  { id: "F5", channel: "CONTEXT", unit: "", base: 1.08, thresholds: {},
    derived: { kind: "highDist", window: 252, amber: 0, red: null, label: derivedLabelOf("F5"), unit: "%" } },
  { id: "NVDA", channel: "CONTEXT", unit: "", base: 130, thresholds: {},
    derived: { kind: "maSpread", window: 200, amber: 0, red: null, label: derivedLabelOf("NVDA"), unit: "%" } },
  { id: "EBP", channel: "FIN", unit: "", base: -0.4, thresholds: { amberLevel: 1.0, redLevel: 2.0 } },
].map(withLabel);

// The CONTEXT / GLOBAL leg-selection + confirmer members that ride ALL_INDICATORS but
// NOT the fast INDICATORS scoring loop (mirror of registry.ts ALL_INDICATORS's explicit
// F6/F8/F9-F13/R6/R7/CG/VT/EURC/FXH/GT/GB/DISP splice). They feed the danger ledger +
// T1 dial off GLOBAL_FAMILIES; prod's /api/indicators returns them, so the Zone-D detail
// picker lists them — a missing one renders a blank card. Bespoke scorers carry
// `thresholds: {}` ⇒ buildChartMock degrades
// to a plain value chart (non-blank). Channels/units mirror registry.ts; labels are imported.
const EXTRA_INDICATORS = [
  { id: "F6", channel: "CONTEXT", unit: "", base: 1.02, thresholds: {} },
  { id: "F8", channel: "CONTEXT", unit: "", base: 95, thresholds: {} },
  { id: "F9", channel: "CONTEXT", unit: "", base: 103, thresholds: thresholdsOf("F9") },
  { id: "F10", channel: "CONTEXT", unit: "", base: 3.0, thresholds: thresholdsOf("F10") },
  { id: "F11", channel: "CONTEXT", unit: "", base: 7.1, thresholds: thresholdsOf("F11") },
  { id: "F17", channel: "CONTEXT", unit: "", base: 150, thresholds: thresholdsOf("F17") },
  { id: "F13", channel: "CONTEXT", unit: "", base: 1.05, thresholds: {} },
  { id: "R6", channel: "COINCIDENT", unit: "", base: 90, thresholds: {} },
  { id: "R7", channel: "RATE", unit: "", base: 0.4, thresholds: {} },
  { id: "CG", channel: "CONTEXT", unit: "", base: 0.19, thresholds: {} },
  { id: "VT", channel: "COINCIDENT", unit: "", base: 0.9, thresholds: {} },
  { id: "EURC", channel: "GLOBAL", unit: "", base: 0.8, direction: "LOW", thresholds: {} },
  // BONOS (Bonos−Bund 10y, bp) — absolute pair IMPORTED, so a hand-set stays a one-place edit.
  { id: "BONOS", channel: "GLOBAL", unit: "bp", base: 90, thresholds: thresholdsOf("BONOS") },
  // ESTR (20d Δ) — derived descriptor IMPORTED whole, so the S3 hand-set stays a one-place edit.
  { id: "ESTR", channel: "GLOBAL", unit: "%", base: 2.0, thresholds: {}, derived: { ...ALL_INDICATORS.find((i) => i.id === "ESTR").derived } },
  // ECISS (ECB CISS, CONTEXT display-only) — level+velocity pairs IMPORTED, so a hand-set stays a one-place edit.
  { id: "ECISS", channel: "CONTEXT", unit: "", base: 0.08, thresholds: thresholdsOf("ECISS") },
  { id: "FXH", channel: "GLOBAL", unit: "", base: 0.0, thresholds: {} },
  { id: "GT", channel: "GLOBAL", unit: "", base: 120, thresholds: {} },
  { id: "GB", channel: "GLOBAL", unit: "", base: 0.7, thresholds: {} },
  { id: "DISP", channel: "GLOBAL", unit: "", base: 0.3, thresholds: {} },
  // ECY excess CAPE yield (vb family, CONTEXT/LOW, monthly). Mock level is ECY in percent (the
  // stored/plotted value; the scored rank rides `decision`); the cut lives on ECY_DESCRIPTOR and
  // the RED is GT-gated, so `thresholds: {}` like the other bespoke composites.
  { id: "ECY", channel: "CONTEXT", unit: "%", base: 1.5, direction: "LOW", thresholds: {} },
  // RS_SMH/RS_XLK EW rel-strength legs (2026-08-15). `thresholds: {}` DELIBERATELY — the real
  // pair is single-sourced on RS_*_DESCRIPTOR; base ≈ the live X/SPY ratio level.
  { id: "RS_SMH", channel: "GLOBAL", unit: "", base: 0.42, direction: "LOW", thresholds: {} },
  { id: "RS_XLK", channel: "GLOBAL", unit: "", base: 0.38, direction: "LOW", thresholds: {} },
  // KBE_RS bank-equity rel-strength — CONTEXT (F6-shape), base ≈ the live KBE/SPY ratio level.
  { id: "KBE_RS", channel: "CONTEXT", unit: "", base: 0.10, direction: "LOW", thresholds: {} },
  // INS_RS European-insurer rel-strength — CONTEXT (KBE_RS shape), base ≈ the live EXH5.DE/EXSA.DE ratio level.
  { id: "INS_RS", channel: "CONTEXT", unit: "", base: 0.80, direction: "LOW", thresholds: {} },
  // EXSH_GATE EU-Fin re-entry gate — CONTEXT (3-check rule B), base ≈ the live EXSH.DE close level.
  { id: "EXSH_GATE", channel: "CONTEXT", unit: "", base: 25, direction: "LOW", thresholds: {} },
  // AT1 bank sub-credit proxy — GLOBAL, seated cr per-leg only (KBE_RS shape), base ≈ the live XAT1.DE/EXHA.DE ratio level.
  { id: "AT1", channel: "GLOBAL", unit: "", base: 0.04, direction: "LOW", thresholds: {} },
  // MU_RS Micron rel-strength — CONTEXT, display-only (KBE_RS shape), base ≈ the live MU/SMH ratio level.
  { id: "MU_RS", channel: "CONTEXT", unit: "", base: 0.45, direction: "LOW", thresholds: {} },
  // JPT Japan trend — CONTEXT, display-only (GT shape), base ≈ the live 1306.T close level.
  { id: "JPT", channel: "CONTEXT", unit: "", base: 420, thresholds: {} },
  // BBB OAS — CONTEXT, value-only (never scored), base ≈ the live BAMLC0A4CBBB level.
  { id: "BBB", channel: "CONTEXT", unit: "%", base: 1.0, thresholds: {} },
].map(withLabel);

/** Ladder config — mirror of ladder.ts ALERT_RANK. */
export const CONFIG = {
  alertRank: { OK: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 },
};

/** Day string N days before 2026-06-28 (fixed epoch — no Date.now needed). */
const EPOCH = Date.parse("2026-06-28T00:00:00Z");
const dayStr = (daysAgo) => new Date(EPOCH - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** A deterministic flat-ish series for one indicator, oldest-first. */
function seriesFor(meta, n) {
  const points = [];
  for (let i = n - 1; i >= 0; i--) {
    // Gentle deterministic wobble around base, always well inside GREEN.
    const wobble = Math.sin(i / 5) * meta.base * 0.02;
    points.push({
      date: dayStr(i),
      value: Number((meta.base + wobble).toFixed(4)),
      delta20: Number((wobble * 0.5).toFixed(4)),
      state: "GREEN",
    });
  }
  return { id: meta.id, points };
}

// The slow "bubble-state" tier's three observability legs. These are NOT in the
// fast INDICATORS set (so prod's /status filters the SLOW channel out of the Zone
// C grid) — but prod's /api/indicators returns the FULL ALL_INDICATORS list, so
// the Zone D detail picker DOES list them (see ALL_INDICATORS_META below; this is
// how the QQQ-63d explainer-gap surfaced). They surface in the dedicated zone-slow
// panel and the Zone D "Bubble tier" tab too, both reading /api/series per id.
// Values are continuous metrics ∈ [0, 1] (a percentile rank or a fraction), oldest-first.
function slowSeriesFor(id, center, amp, n = 60) {
  const points = [];
  for (let i = n - 1; i >= 0; i--) {
    const v = center + Math.sin(i / 7) * amp;
    points.push({
      date: dayStr(i),
      value: Number(Math.min(0.999, Math.max(0.001, v)).toFixed(4)),
      delta20: Number((Math.sin(i / 7) * amp * 0.5).toFixed(4)),
      state: "GREEN",
    });
  }
  return { id, points };
}
const SLOW_SERIES = {
  "price-accel": slowSeriesFor("price-accel", 0.84, 0.08), // hovering between the 0.80/0.95 cuts
  "complacency-vix": slowSeriesFor("complacency-vix", 0.12, 0.06), // dipping toward the 0.10 low-decile cut
  "complacency-high": slowSeriesFor("complacency-high", 0.95, 0.04), // pressing the 0.98 near-high cut
  "complacency-duration": slowSeriesFor("complacency-duration", 0.55, 0.10), // mid-range calm-streak percentile
};

// The pension track's raw legs (SPY equity price + EURUSD FX rate).
// Like SLOW_SERIES these are NOT in the fast INDICATORS set (prod's /status filters
// the PENSION channel out of the grid), but they ARE in /api/indicators, so the
// detail picker lists them; they also surface via /api/series for the off-ladder
// pension panel (zone-pension), which recomputes the blended EUR drawdown client-side.
// Shared dates (same dayStr epoch) so the panel's three-way inner-join aligns; a
// gentle rise → shallow pullback gives a faithful CALM (~few-percent) drawdown
// curve, consistent with the STATUS pensionBand=CALM / pensionDd below.
function levelSeries(id, base, amp, n = 60) {
  const points = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = (n - 1 - i) / (n - 1); // 0 oldest → 1 newest
    const value = base * (1 + amp * Math.sin(t * 2.6)); // peak ≈ t0.6, eases off by newest
    points.push({ date: dayStr(i), value: Number(value.toFixed(4)), delta20: 0, state: "GREEN" });
  }
  return { id, points };
}
// Synthetic € level series for every leg-chart id (LEG_CHART_ID: the `LEGP_*` rows + `XDEV`), served
// as ORDINARY indicators (meta in SLOW_PENSION_META + a SERIES entry) so the Zone D leg slot — a plain
// member slot since etf-dedup step 4 — paints its PENSION chart, as prod does. Ids DERIVED from the FE seam.
const LEG_CHART_IDS = [...new Set(Object.values(LEG_CHART_ID))];
const LEG_CHART_SERIES = Object.fromEntries(LEG_CHART_IDS.map((id, k) => [id, levelSeries(id, 80 + k * 12, 0.06)]));

const PENSION_SERIES = {
  SPY: levelSeries("SPY", 580, 0.08),
  DEXUSEU: levelSeries("DEXUSEU", 1.08, 0.015), // USD per EUR
};

// The two raw VIX-bottom legs. Their cards are clickable like any other, so the
// fixture must carry them or the Zone-D detail tab cannot resolve `VIX`/`VIX3M`.
const BOTTOM_SERIES = {
  VIX: levelSeries("VIX", 15, 0.12),
  VIX3M: levelSeries("VIX3M", 18, 0.09),
};

export const SERIES = {
  // Derived indicators need a deep series (≥ their lookback window) so the detail
  // chart's secondary derived line renders fully, not just the "accruing" stub.
  ...Object.fromEntries(INDICATORS.map((m) => [m.id, seriesFor(m, m.derived ? 300 : 40)])),
  ...Object.fromEntries(EXTRA_INDICATORS.map((m) => [m.id, seriesFor(m, m.derived ? 300 : 40)])),
  ...SLOW_SERIES,
  ...PENSION_SERIES,
  ...LEG_CHART_SERIES,
  ...BOTTOM_SERIES,
};

// Case 5 — unconfirmed-breach hatch preview: EBP's last two closes carry a raw
// AMBER breach whose confirmed state stays GREEN, so the detail ribbon's hatched
// window is visible in the mock. Prod reaches this only through STORED
// pre-2026-07-26 rows (api/series.ts serves them verbatim) — since IS-5 every
// indicator confirms same-day, so no new row diverges. Synthetic on purpose.
for (const p of SERIES.EBP.points.slice(-2)) p.rawState = "AMBER";

// Derived decision series: the generic detail chart (Case 1) reads the persisted
// `decision` verbatim off the wire (`fromPoint: "decision"`), so EVERY derived
// indicator's mock points must carry it — seeded here from the mock values,
// mirroring each live scorer's shape (return / % from rolling high / % vs MA).
const DECIDE = {
  return: (vals, i, win) => (i >= win ? vals[i] / vals[i - win] - 1 : null),
  change: (vals, i, win) => (i >= win ? vals[i] - vals[i - win] : null),
  highDist: (vals, i, win) => {
    if (i < win - 1) return null; // full inclusive window only, mirroring live (scorers-core.ts derivedBaseOffset)
    const hi = Math.max(...vals.slice(i - win + 1, i + 1));
    return vals[i] / hi - 1;
  },
  maSpread: (vals, i, win) => {
    if (i < win - 1) return null;
    const w = vals.slice(i - win + 1, i + 1);
    return vals[i] / (w.reduce((a, b) => a + b, 0) / win) - 1;
  },
};
for (const m of [...INDICATORS, ...EXTRA_INDICATORS]) {
  const d = m.derived;
  if (!d || !DECIDE[d.kind]) continue;
  const pts = SERIES[m.id].points;
  const vals = pts.map((p) => p.value);
  pts.forEach((p, i) => {
    const v = DECIDE[d.kind](vals, i, d.window);
    if (v != null) p.decision = Number(v.toFixed(4));
  });
}

// Case 4 — gate-off preview: F4's decision line stays one uniform line (an earlier commit retired
// the dimming); a gate-off span only adds the legend clause. Per-point `gates`, with BOTH
// gates off over a recent 20-day window so that clause renders inside the detail view.
{
  const pts = SERIES.F4.points;
  pts.forEach((p) => {
    p.gates = { smhBelowMA200: true, nvdaBelowMA200: false };
  });
  for (const p of pts.slice(-40, -20)) p.gates = { smhBelowMA200: false, nvdaBelowMA200: false };
}

export const INDICATORS_META = INDICATORS.map(({ base, ...meta }) => meta);
const EXTRA_META = EXTRA_INDICATORS.map(({ base, ...meta }) => meta);

// The SLOW/PENSION metas (mirror of src/registry.ts ALL_INDICATORS tail). They are
// NOT in the fast INDICATORS set (kept out of the grid + readings), but prod's
// /api/indicators serves the full ALL_INDICATORS, so the detail picker lists them.
// thresholds:{} + provenance:"convention" → no provenance chip (matches prod). Labels come from the
// registry's `label` — the SHORT name, which is what /api/indicators serves (`label: i.label`); these
// rows used to restate the registry's `longLabel` instead, so the preview's SLOW/PENSION cards read
// nothing like prod's. `series` is ALSO imported now (withLabelSeries, stage 3 name-dup backlog): the
// hand-typed VIX/VIX3M literals had drifted from the registry's "^VIX"/"^VIX3M".
const SLOW_PENSION_META = [
  { id: "price-accel", channel: "SLOW", unit: "", thresholds: {} },
  { id: "complacency-vix", channel: "SLOW", unit: "", thresholds: {} },
  { id: "complacency-high", channel: "SLOW", unit: "", thresholds: {} },
  { id: "complacency-duration", channel: "SLOW", unit: "", thresholds: {} },
  { id: "SPY", channel: "PENSION", unit: "", thresholds: {} },
  { id: "DEXUSEU", channel: "PENSION", unit: "", thresholds: {} },
  { id: "VIX", channel: "BOTTOM", unit: "", thresholds: {} },
  { id: "VIX3M", channel: "BOTTOM", unit: "", thresholds: {} },
  // The leg-chart ids — channel/unit off the registry row (PENSION, "€"), never restated here.
  ...LEG_CHART_IDS.map((id) => {
    const { channel, unit } = ALL_INDICATORS.find((i) => i.id === id) ?? {};
    if (!channel) throw new Error(`mock-data: leg-chart id "${id}" has no registry row`);
    return { id, channel, unit, thresholds: {} };
  }),
].map(withLabelSeries);

// --- Family grouping (mirror of src/families.ts US/GLOBAL/DASHBOARD_FAMILIES / SIGNAL_OF) ----
// Faithful hand-mirror. (Importable in principle since the preview moved to `tsx` — the `note`/
// `desc`/`awaiting` copy below is preview-only, so this table stays hand-authored for now.)
// Mirrors the families.ts derivation chain — US_FAMILIES (7 keys, Stage 1.2)
// → GLOBAL_FAMILIES (re-points/appends) → DASHBOARD_FAMILIES (per-family union) — so the
// mock can't hand-type three parallel tables. Both /api/families (heading + order) and each
// meta's derived `family` key are single-sourced HERE (finding 1); /api/lab's LAB fixture
// below derives from the same tables.
const US_FAMILIES = [
  { key: "credit", label: familyLabelOf("credit"), ids: ["F1", "F2", "F3", "EBP"],
    note: "US$ spreads only — no EUR/EM credit.",
    desc: "Leading: HY/IG credit-spread stress — spreads widening from their trough (widening = risk-off); stress shows here first." },
  { key: "rates", label: familyLabelOf("rates"), ids: ["R1", "R2", "R3", "R4", "R7", "R6"],
    note: "US Treasury curve + MOVE bond-vol — no Bund/JGB.",
    desc: "Leading: interest-rate / term-structure stress — curve inversion / rate shock + bond-vol (MOVE) (inverted polarity — lower/negative = worse)." },
  { key: "valuation", label: familyLabelOf("valuation"), ids: ["ECY"],
    note: "ECY (excess CAPE yield, GT trend-gated) — RED only when expensive AND trend-broken; F7 CAPE stays a CONTEXT card.",
    awaiting:
      "regional CAPE (EU / ex-US / EM): no keyless source. ECY covers US valuation only.",
    desc: "Leading: stretched equity valuation / bubble extension (CAPE, forward-P/E) — a rich market has further to fall." },
  // `macro-cycle` sat here until 2026-07-17 — key removed (DEC-22) once its only members
  // (F12/F14/F15) were retired as dead feeds. Mirror of src/families.ts.
  { key: "volatility", label: familyLabelOf("volatility"), ids: ["R5", "VT", "price-accel", "complacency-vix", "complacency-high", "complacency-duration"],
    note: "US vol (VIX/VIX-term) + complacency legs — no V2X/regional.",
    desc: "Coincident fear + leading complacency: the realized/implied volatility regime (VIX level, term structure) folded with stretched-positioning warnings — acceleration, suppressed vol, duration-of-calm (fires in CALM markets too)." },
  { key: "cross-asset", label: familyLabelOf("cross-asset"), ids: ["CG"],
    note: "US proxy (copper/gold) — dispersion + FX-haven legs are global-only.",
    desc: "Coincident risk-on/risk-off across assets: safe-haven demand (FX haven + copper/gold) plus the breadth of a systemic, all-regions-falling move (dispersion) — havens bid + is stress broad or isolated." },
  { key: "trend", label: familyLabelOf("trend"), ids: ["F4", "F5", "NVDA"],
    note: "US-tech proxies; can fire at market highs (F5 amber = 12-mo high & rising); F5/NVDA never RED.",
    desc: "Coincident: global trend + breadth (GT/GB) plus the US-tech proxies (F4/F5 + NVDA) of a big-tech drawdown — index vs trend + participation (real signal at bottoms, noisy at tops)." },
  { key: "geopolitics", label: familyLabelOf("geopolitics"), ids: ["G1"],
    note: "auto: WTI spike",
    desc: "oil/commodity + geopolitical shock (WTI spike)." },
];

/** Mirror of families.ts GLOBAL_FAMILIES: rates+EURC+ESTR, credit+F13/F10; cross-asset/trend re-pointed. */
const GLOBAL_FAMILIES = US_FAMILIES.map((f) => {
  if (f.key === "rates") return { ...f, ids: [...f.ids, "EURC", "ESTR"] };
  if (f.key === "credit") return { ...f, ids: [...f.ids, "F13", "F10"] };
  if (f.key === "cross-asset") return { ...f, ids: ["FXH", "CG", "DISP", "F9", "F11", "F17"] };
  if (f.key === "trend") return { ...f, ids: ["GT", "GB", "F4", "F5", "NVDA", "F6", "F8"] };
  // macro-cycle's F12/F14/F15 re-point is GONE (2026-07-17 dead-feed retirement) — the family
  // was memberless in both tables and its key has since been removed, mirroring src/families.ts.
  return f;
});

/** Mirror of families.ts DASHBOARD_FAMILIES: per-family US ∪ GLOBAL union, zipped by index. */
const DASHBOARD_FAMILIES = US_FAMILIES.map((u, i) => ({
  ...u,
  ids: [...new Set([...u.ids, ...(GLOBAL_FAMILIES[i]?.ids ?? [])])],
}));

/** The CARD GROUP a served indicator id renders under — mirror of families.ts `cardGroupOf`: panel
 *  family (the mirrored tables above) first, then the REAL display-only overlay. `/api/indicators`
 *  sets every `meta.family` from `cardGroupOf`, NEVER from `familyOf` (api/indicators.ts) — reading
 *  membership here instead left `VIX`/`VIX3M`/`SPY`/`DEXUSEU`/`SP500IT`/`BAA10Y`/
 *  `DB_SMH`/`DB_XLK`/`F7` in "Other" and dropped the whole `pension-drawdown` zone as empty, so the
 *  preview painted something prod does not. `undefined` only for ids in no family AND no overlay. */
const cardGroupOf = (id) =>
  DASHBOARD_FAMILIES.find((f) => f.ids.includes(id))?.key ?? CARD_ONLY_GROUPS.find((g) => g.ids.includes(id))?.key;

/** GET /api/families payload (mirror of meta-views.ts familiesView): key/label/desc + the
 *  RENDER RANK `ids` (ranked members, then this family's card-only overlay ids), in render
 *  order, then a synthetic entry per non-family card zone. The overlay/zone half comes from the
 *  REAL `CARD_ONLY_GROUPS` — the mock hand-mirrors the family tables above, never that roster. */
export const FAMILIES_META = [
  ...DASHBOARD_FAMILIES.map(({ key, label, desc, ids }) => ({
    key,
    label,
    desc,
    ids: [...new Set([...ids, ...CARD_ONLY_GROUPS.filter((g) => g.key === key).flatMap((g) => g.ids)])],
  })),
  ...CARD_ONLY_GROUPS.filter((g) => !DASHBOARD_FAMILIES.some((f) => f.key === g.key)).map((g) => ({
    key: g.key,
    label: g.label,
    ids: [...g.ids],
  })),
];

// --- Danger model (mirror of src/danger-ladder.ts + SIGNAL_OF) --------------------
// The 9 leg sleeves in ladder order — the reach axis MEMBER_RELEVANCE is derived over.
const ALL_LEGS = ["Semis", "S&P IT", "EM", "Value", "S&P 500", "ex-US", "EU-Fin", "Health", "Staples"];

// Per-member × leg danger weight (verbatim mirror of danger-ladder.ts MEMBER_WEIGHT);
// MEMBER_RELEVANCE below is derived from its non-zero support (single source, no hand-typed mask).
const MEMBER_WEIGHT = {
  R1: { Semis: 1.0, "S&P IT": 0.8, EM: 1.0, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  R2: { Semis: 1.0, "S&P IT": 1.0, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.6, Health: 0.4, Staples: 0.6 },
  R3: { Semis: 0.8, "S&P IT": 0.8, EM: 1.0, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  R4: { Semis: 0.6, "S&P IT": 1.0, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.6, Health: 0.4, Staples: 0.6 },
  R7: { Semis: 1.0, "S&P IT": 0.8, EM: 1.0, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  EURC: { Semis: 0.6, "S&P IT": 0.3, EM: 0.4, Value: 0.6, "S&P 500": 0.2, "ex-US": 0.8, "EU-Fin": 0.8, Health: 0.4, Staples: 0.4 },
  F1: { Semis: 0.6, "S&P IT": 1.0, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6 },
  F2: { Semis: 0.8, "S&P IT": 0.8, EM: 0.6, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6 },
  EBP: { Semis: 1.0, "S&P IT": 0.8, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4 },
  R5: { Semis: 0.6, "S&P IT": 1.0, EM: 0.8, "S&P 500": 0.6, "ex-US": 0.6 },
  VT: { Semis: 0.6, "S&P IT": 1.0, EM: 0.6, "S&P 500": 0.6, "ex-US": 0.6 },
  R6: { Semis: 0.8, "S&P IT": 0.8, "EU-Fin": 0.4, Staples: 0.6 },
  FXH: { Semis: 1.0, "S&P IT": 0.8, EM: 1.0, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.8 },
  CG: { Semis: 1.0, "S&P IT": 0.6, EM: 1.0, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.8 },
  DISP: { EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6 },
  GT: { Semis: 1.0, "S&P IT": 0.8, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6 },
  GB: { Semis: 1.0, "S&P IT": 0.8, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6 },
  F4: { Semis: 0.8, "S&P IT": 0.8 },
  F5: { Semis: 1.0, "S&P IT": 0.8 },
  NVDA: { Semis: 1.0, "S&P IT": 0.6 },
  F6: { Semis: 1.0, "S&P IT": 0.8, EM: 0.4 },
  F8: { Semis: 0.6, "S&P IT": 0.4 },
  F9: { EM: 1.0, "ex-US": 0.8, Semis: 0.6, "S&P IT": 0.4, "S&P 500": 0.4, Value: 0.4 },
  F10: { EM: 1.0, "ex-US": 0.6, Semis: 0.4, "S&P 500": 0.4, Value: 0.4 },
  F11: { EM: 1.0, Semis: 0.8, "ex-US": 0.6, Value: 0.6, "S&P 500": 0.4 },
  F17: { Value: 1.0 },
  F13: { Value: 1.0, "S&P 500": 0.8, "ex-US": 0.7, EM: 0.7, "EU-Fin": 0.6, Semis: 0.5, "S&P IT": 0.4 },
  G1: { Semis: 0.8, "S&P IT": 0.8, EM: 1.0, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6 },
  "price-accel": { Semis: 1.0, "S&P IT": 1.0, EM: 0.6, "S&P 500": 0.8, "ex-US": 0.4 },
  "complacency-vix": { Semis: 0.8, "S&P IT": 0.8, EM: 0.6, "S&P 500": 0.6, "ex-US": 0.4 },
  "complacency-high": { Semis: 1.0, "S&P IT": 1.0, EM: 0.6, "S&P 500": 0.8, "ex-US": 0.4 },
  "complacency-duration": { Semis: 0.6, "S&P IT": 0.6, EM: 0.4, "S&P 500": 0.6, "ex-US": 0.4 },
};

const SIGNAL_OF = {
  credit: "cr", rates: "rt", valuation: "vb", volatility: "vl",
  "cross-asset": "xa", trend: "uT", geopolitics: "gp",
};

// MEMBER_LABEL is IMPORTED from src/danger-ladder.ts (top of file) — the real derived table
// (`Object.keys(MEMBER_WEIGHT) → ALL_INDICATORS.find(...).label`), so there is nothing to drift.

/** GET /api/danger-model payload (mirror of api/danger-model.ts) — the STATIC reference block.
 *  memberRelevance is DERIVED from MEMBER_WEIGHT's non-zero support (single source). */
export const DANGER_MODEL = {
  signalOf: SIGNAL_OF,
  familyOfSignal: Object.fromEntries(Object.entries(SIGNAL_OF).map(([f, s]) => [s, f])),
  // Lead-time super-groups (Stage 5.1; 7-key taxonomy mirror of danger-ladder.ts
  // SUPER_GROUPS / SUPER_GROUP_OF, Stage 7.1).
  superGroups: ["EARLY-WARN", "STRESS-NOW", "CONFIRMING", "EXOGENOUS"],
  superGroupOf: {
    cr: "EARLY-WARN", rt: "EARLY-WARN", vb: "EARLY-WARN",
    vl: "STRESS-NOW", xa: "STRESS-NOW",
    uT: "CONFIRMING", gp: "EXOGENOUS",
  },
  memberRelevance: Object.fromEntries(
    Object.entries(MEMBER_WEIGHT).map(([id, row]) => [id, ALL_LEGS.filter((s) => (row[s] ?? 0) > 0)]),
  ),
  // Raw per-member × leg magnitudes (served since R3, 2026-07-18 — lab.js prints them as `×weight`).
  // Was ABSENT from this mock though `DangerModel.required` lists it: the new parity guard
  // (mock-danger-model-parity.test.js) found it. Copied per row so a preview tweak cannot write
  // through to the table above.
  memberWeight: Object.fromEntries(Object.entries(MEMBER_WEIGHT).map(([id, row]) => [id, { ...row }])),
  memberLabel: MEMBER_LABEL,
  // Every knob below is the REAL export (see the import block at the top of this file), so the
  // preview can never render a retired gate — or a stale cut — as current.
  clusters: CLUSTERS.map((c) => [...c]),
  concThreshold: CONC_THRESHOLD,
  concWeight: CONC_WEIGHT,
  deriskDeadband: DERISK_DEADBAND,
  reriskDeadband: RERISK_DEADBAND,
  reriskConfirm: RERISK_CONFIRM,
  // Was ABSENT entirely though `openapi.yaml` lists it in `DangerModel.required` — the parity test
  // below (mock-danger-model-parity.test.js) now reds on any required key this block omits.
  reriskDwellDays: RERISK_DWELL_DAYS,
  legRagCuts: { amber: DANGER_CUTS.amber, red: DANGER_CUTS.red },
  pillarIds: [...PILLAR_MEMBER_IDS],
};

// Declarative detail-chart `chart` spec per meta — minimal MIRROR of
// api/indicators.ts buildChart (Case 1). SEAM: the real builder is a Vercel handler that reaches
// the store/feed layer, so the mock reproduces its SHAPE rather than calling it; a new spec
// category added there must be hand-mirrored here (like families/danger-model above).
// Categories present in this mock set: derived-kind (G1/F4/F5/NVDA), generic level
// (F1/F2/R1/R5/EBP), generic velocity (R2/R3/R4), plain (SLOW/PENSION/BOTTOM).
// FXH/VT are not in the mock, so their bespoke branches are intentionally absent.
// Case 4 gate declarations — hand-mirror of src/gates.ts GATES for the ids in this
// mock set (F8 is not mocked). Drives the mock chart spec's `gates` + `gatedBy`.
// Exported for the drift guard (scripts/preview/mock-gates-parity.test.js).
export const GATES_MOCK = {
  F4: [
    { key: "smhBelowMA200", label: "SMH below its 200-day MA", appliesTo: "amber" },
    { key: "nvdaBelowMA200", label: "NVDA below its 200-day MA", appliesTo: "red" },
  ],
  DISP: [
    { key: "corrAtOrAboveCut", label: "global correlation at/above its confirm cut", appliesTo: "both" },
  ],
  // R5 2026-08-06 — the oil trailing-peak gate. BRENT carries the twin def in src/gates.ts but
  // is absent from ALL_INDICATORS_META, so the reverse-drift check does not reach it and there
  // is nothing here for the preview to render.
  G1: [
    { key: "atTrailingPeak", label: "WTI at/above its trailing 3-year peak", appliesTo: "red" },
  ],
};

function buildChartMock(m) {
  const unit = m.unit ?? "%";
  const d = m.derived;
  if (d && d.kind !== "identity") {
    const bands = [];
    if (d.amber != null) bands.push({ level: "amber", axis: "secondary", source: "derived", value: d.amber });
    if (d.red != null) bands.push({ level: "red", axis: "secondary", source: "derived", value: d.red });
    const gates = GATES_MOCK[m.id];
    return {
      axes: [
        { id: "primary", side: "left", unit, format: "value" },
        { id: "secondary", side: "right", unit: d.unit, format: "derived", label: d.label },
      ],
      series: [
        { axis: "primary", fromPoint: "value", style: "primary" },
        { axis: "secondary", fromPoint: "decision", style: "derived", ...(gates ? { gatedBy: gates.map((g) => g.key) } : {}) },
      ],
      bands,
      ...(gates ? { gates } : {}),
    };
  }
  const t = m.thresholds ?? {};
  if (t.amberLevel != null || t.redLevel != null) {
    return {
      axes: [{ id: "primary", side: "left", unit, format: "value" }],
      series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
      bands: [
        { level: "amber", axis: "primary", source: "threshold", metric: "level" },
        { level: "red", axis: "primary", source: "threshold", metric: "level" },
      ],
    };
  }
  if (t.amberVelocity != null || t.redVelocity != null) {
    return {
      axes: [{ id: "primary", side: "left", unit: "", format: "value" }],
      series: [{ axis: "primary", fromPoint: "delta20", style: "primary" }],
      bands: [
        { level: "amber", axis: "primary", source: "threshold", metric: "velocity" },
        { level: "red", axis: "primary", source: "threshold", metric: "velocity" },
      ],
    };
  }
  // Case 3 — EURC/GB/DISP mirror the real builder's displayBand branches (values
  // hand-copied from src/family-descriptor-rows.ts: EURC_AMBER/RED, GB_AMBER/RED, DISP_CORR — a
  // scorer retune must be re-mirrored here, like the base rates above).
  if (m.id === "EURC") {
    return {
      axes: [{ id: "primary", side: "left", unit, format: "value" }],
      series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
      bands: [
        { level: "amber", axis: "primary", source: "displayBand", value: 0.5, label: "amber <0.50" },
        { level: "red", axis: "primary", source: "displayBand", value: 0.0, label: "red <0.00" },
      ],
    };
  }
  if (m.id === "GB") {
    return {
      axes: [{ id: "primary", side: "left", unit, format: "value" }],
      series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
      bands: [
        { level: "amber", axis: "primary", source: "displayBand", value: 0.5, label: "amber <0.50" },
        { level: "red", axis: "primary", source: "displayBand", value: 0.3, label: "red <0.30" },
      ],
    };
  }
  if (m.id === "DISP") {
    // Case 4 (2026-07-20; DISP redesign 2026-07-22) — mirrors the real builder's DISP branch:
    // the BASKET return is drawn on a secondary axis with one RED band at the −2.5% depth
    // trigger (DISP_BASKET_RED), and the corr level rides as a single confirm cut gate.
    // Hand-mirror; GATES_MOCK.DISP is drift-guarded against src/gates.ts by
    // mock-gates-parity.test.js.
    const gates = GATES_MOCK[m.id];
    return {
      axes: [
        { id: "primary", side: "left", unit, format: "value" },
        { id: "secondary", side: "right", unit: "%", format: "value", label: "20d basket return" },
      ],
      series: [
        { axis: "primary", fromPoint: "value", style: "primary" },
        { axis: "secondary", fromPoint: "decision", style: "derived", gatedBy: gates.map((g) => g.key) },
      ],
      bands: [{ level: "red", axis: "secondary", source: "displayBand", value: -0.025, label: "red <−2.5% · corr>0.75" }],
      gates,
    };
  }
  // Case 3 — genuinely unbanded (identity) ids declare the explicit sentinel, mirroring
  // the real builder (never a silent empty array — that is no longer a valid emit shape).
  return {
    axes: [{ id: "primary", side: "left", unit, format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands: "context-only",
  };
}
// --- GET /api/lab fixture (mirror of api/lab.ts LIVE path, all-calm) ---------------
// DERIVED from the same tables above (US/GLOBAL_FAMILIES, MEMBER_WEIGHT, SIGNAL_OF,
// superGroupOf) — no third hand-typed membership table. Served STATICALLY: the mock
// /api/lab ignores ?s=/?hist= (documented preview limitation; use preview:live for
// scenario/momentum work). Mirrors src/families.ts LabResponse field-for-field.

/** Mirror of danger-ladder.ts LEG_FIELD (lab.js renders region/rgn/sector/sec/exposure/style/risk). */
const LEG_FIELD = [
  { sleeve: "Semis",    region: "Global-AW", rgn: "AW",   exposure: "Semiconductors", sector: "Semiconductors",       sec: "Semis",   style: "Growth / high-beta", risk: 1 },
  { sleeve: "S&P IT",   region: "US",        rgn: "US",   exposure: "Info-Tech",      sector: "Info-Tech",            sec: "Tech",    style: "Growth",             risk: 2 },
  { sleeve: "EM",       region: "Emerging",  rgn: "EM",   exposure: "Broad",          sector: "Broad-market",         sec: "Broad",   style: "Cyclical",           risk: 3 },
  { sleeve: "Value",    region: "Global-DM", rgn: "DM",   exposure: "Value",          sector: "Broad (Value factor)", sec: "Value",   style: "Value",              risk: 4 },
  { sleeve: "S&P 500",  region: "US",        rgn: "US",   exposure: "Broad",          sector: "Broad-market",         sec: "Broad",   style: "Blend",              risk: 5 },
  { sleeve: "ex-US",    region: "Dev ex-US", rgn: "exUS", exposure: "Broad",          sector: "Broad-market",         sec: "Broad",   style: "Blend",              risk: 6 },
  { sleeve: "EU-Fin",   region: "Europe",    rgn: "EU",   exposure: "High-dividend / fins-heavy", sector: "High-div (60% fins)", sec: "HiDiv",   style: "Value-income",       risk: 7 },
  { sleeve: "Health",   region: "Global-DM", rgn: "DM",   exposure: "Healthcare",     sector: "Healthcare",           sec: "Health",  style: "Defensive",          risk: 8 },
  { sleeve: "Staples",  region: "Global-DM", rgn: "DM",   exposure: "Cons. staples",  sector: "Cons. staples",        sec: "Staples", style: "Defensive",          risk: 9 },
];

/** All-calm FamilyPanel[] over a family-def table (mirror of computeFamilyPanel: every
 *  fed member present + GREEN; a feedless family (empty ids) is live:false / state null —
 *  none since ECY seated valuation, the branch stays for a future feedless family). */
const calmPanel = (defs) =>
  defs.map((f) => {
    const live = f.ids.length > 0;
    const members = f.ids.map((id) => ({ id, label: labelOf(id), state: "GREEN" }));
    return {
      key: f.key, label: f.label,
      state: live ? "GREEN" : null,
      live, firing: false,
      contribution: live ? 0 : null,
      members,
      // IS-7 Stage 1's new served field (computeFamilyPanel: ids.length − members.length).
      // DERIVED, not typed: every mock member is present, so this is 0 today, but it stays
      // right if the mock ever drops one — and the /lab diffusion count (diffusion-label.js)
      // reads it, so a hand-typed 0 would paint a false "of N with nothing dark" the moment a
      // mock family stops serving every member.
      absent: f.ids.length - members.length,
      note: f.note, desc: f.desc, awaiting: f.awaiting,
    };
  });
const US_PANEL = calmPanel(US_FAMILIES);
const GLOBAL_PANEL = calmPanel(GLOBAL_FAMILIES);
/** Mirror of danger-ladder.ts DIAL_FAMILIES = GLOBAL_FAMILIES minus the display-only SLOW legs.
 *  The exclusion set is IMPORTED (never re-typed) so this mock cannot drift from the registry; it
 *  is what /lab's diffusion count folds since the C1 ruling,
 *  so a mock without
 *  it paints a blank count under every tile. */
const DIAL_PANEL = calmPanel(
  GLOBAL_FAMILIES.map((f) => ({ ...f, ids: f.ids.filter((id) => !SLOW_INDICATOR_IDS.has(id)) })),
);

// Per-leg all-calm signal cells derived from MEMBER_WEIGHT support: N = relevant member
// count (weight > 0), M = 0, cellState na|calm, wsev null|0 (mirror of computeCells).
const SIGNAL_KEYS = ["cr", "rt", "vb", "vl", "xa", "uT", "gp"]; // super-group render order (mirror of SIGNALS)
const FAMILY_MEMBERS_BY_SIGNAL = Object.fromEntries(
  GLOBAL_FAMILIES.map((f) => [SIGNAL_OF[f.key], f.ids]),
);
const EW = new Set(["cr", "rt", "vb"]);
const SN = new Set(["vl", "xa"]);
const LAB_LEG_ROWS = LEG_FIELD.map((l, i) => {
  const cells = SIGNAL_KEYS.map((family) => {
    const N = FAMILY_MEMBERS_BY_SIGNAL[family].filter((m) => (MEMBER_WEIGHT[m]?.[l.sleeve] ?? 0) > 0).length;
    return { family, cellState: N === 0 ? "na" : "calm", M: 0, N, wsev: N === 0 ? null : 0 };
  });
  // subDangers: a pillar is `scored` (0) iff it has ≥1 non-na cell for this leg, else the
  // `not-live` arm of the W6 Stage 6.5 `PillarScore` union (src/danger-engine.ts) — the mock must
  // ship the UNION, not the pre-6.5 `number | null`, or every /lab bar renders `na`.
  const pillar = (set) =>
    cells.some((c) => set.has(c.family) && c.wsev !== null)
      ? { kind: "scored", value: 0 }
      : { kind: "uncomparable", reason: "not-live" };
  const earlyWarn = pillar(EW);
  const stressNow = pillar(SN);
  const litOf = (set) => ({ lit: 0, of: cells.filter((c) => set.has(c.family) && c.wsev !== null).length });
  return {
    ...l,
    cells,
    danger: 0,
    subDangers: { earlyWarn, stressNow },
    // All-calm ⇒ no family lit; `of` = the pillar's observed families.
    familiesLit: { earlyWarn: litOf(EW), stressNow: litOf(SN) },
    // Varied 5-close SN speed: row 0 ships NO snRoc (the no-arrow path — scenario/degraded/
    // SN-not-live); the rest cycle below-cut flat "→" / level-1 up / level-2 down (any
    // numeric snRoc renders a glyph).
    ...(i === 0 ? {} : { snRoc: [0.01, 0.03, -0.06][i % 3] }),
    // All-calm ⇒ both pillars low ⇒ CALM regime (mirror of confirmedRegime over an
    // all-low pillar pair, danger-engine.ts). Non-live pillar counts as LOW.
    regime: "calm",
    concentrated: false,
  };
});

/** All-calm T1 dial (mirror of computeT1Dial over the calm GLOBAL panel). */
const LAB_T1DIAL = {
  leadingFiring: 0,
  coincidentFiring: 0,
  band: { lo: 1, hi: 1 },
  leadingP: 0,
  coincidentP: 0,
  techConfirmerP: 0,
  positionP: 0,
  armed: false,
  fired: false,
  shockOverride: false,
  systemicBump: 0,
  rung: 1,
  dangerScore: 0,
  targetRung: 1,
  regime: "Calm",
  headline: "unprimed + unfired → Calm, rung 1",
  graded: "coarse",
};

export const LAB = {
  families: US_PANEL,
  liveFamilyCount: US_PANEL.filter((f) => f.live).length,
  firingCount: 0,
  ladder: LEG_FIELD.map((l) => l.sleeve),
  t1dial: LAB_T1DIAL,
  globalFamilies: GLOBAL_PANEL,
  dialFamilies: DIAL_PANEL,
  field: {
    legRows: LAB_LEG_ROWS,
    band: LAB_T1DIAL.band,
    // calm band [1,1] ⇒ the calmest-in-band held pick is the Semis row.
    held: LAB_LEG_ROWS.find((l) => l.sleeve === "Semis"),
    exogenous: { active: false, floor: 0 },
  },
  downsideDetectors: [
    { id: "SMH", state: "GREEN" },
    { id: "NVDA", state: "GREEN" },
    { id: "QQQ", state: "GREEN" },
  ],
  // Live path: hyOas = the F1 reading's raw level; VT is not a mock reading ⇒ null.
  r4: { cash: false, phase: null, reentryRung: null, hyOas: 3.5, vt: null, reason: "" },
  mode: "live",
  asOf: dayStr(0),
  firedAt: `${dayStr(0)}T05:00:00.000Z`,
};

// What /api/indicators returns in prod (ALL_INDICATORS) — drives the Zone D detail
// picker, which has no channel filter, so every id must carry an explainer. Each meta
// carries the derived `family` key (mirror of the live path's `family: cardGroupOf(i.id)`,
// api/indicators.ts — the CARD GROUP, so the display-only overlay ids and the synthetic
// `pension-drawdown` zone group here exactly as they do in prod), so the Dashboard's Zone C
// can group cards by it; ids in no family and no overlay (PENSION/BOTTOM leftovers) get
// `undefined`, which drops out of the JSON like the live path. Each also carries the
// `chart` spec (mirror of the live `chart: buildChart(...)`) — the generic detail
// renderer draws PURELY from it, so a meta without one shows the degrade message.
export const ALL_INDICATORS_META = [...INDICATORS_META, ...EXTRA_META, ...SLOW_PENSION_META].map((m) => ({
  ...m,
  family: cardGroupOf(m.id),
  chart: buildChartMock(m),
}));

/** Latest reading per indicator (all GREEN / calm). */
const READINGS = INDICATORS.map((m) => {
  const pts = SERIES[m.id].points;
  const last = pts[pts.length - 1];
  return { indicatorId: m.id, value: last.value, delta20: last.delta20, state: "GREEN", rawState: "GREEN" };
});

export const STATUS = {
  asOf: dayStr(0),
  stale: false,
  feedAgeDays: 0,
  // Default "all calm": bottom track CALM with live numbers in calm contango
  // (ratio < 1), slow track CALM, pension track CALM with a shallow (sub-DIP)
  // drawdown. Flip bottomState to CAPITULATION-WATCH / BOTTOM-FORMING (and bump
  // vix / ratio), or slowBand to "ELEVATED" / "DE-RISK" (and bump slowScore to
  // 2 / 3), or pensionBand to "DIP" / "CORRECTION" / "BEAR" (and deepen pensionDd
  // / pensionUsDd / pensionNonusDd, all ≤0 fractions), to preview the active
  // panels. Numbers null together = degraded feed (muted "signal unavailable").
  verdict: {
    level: "OK",
    fin: 0,
    rate: 0,
    geoFlags: 0,
    finReds: 0,
    coincident: "GREEN",
    bottomState: "CALM",
    vix: 14.5,
    vix3m: 16.8,
    ratio: Number((14.5 / 16.8).toFixed(2)),
    slowScore: 1,
    // The run's own denominator (2 × activeCount, src/slow.ts) — the panel renders `score / this`.
    slowMaxScore: 4,
    slowBand: "CALM",
    pensionBand: "CALM",
    pensionDd: -0.041,
    pensionUsDd: -0.028,
    pensionNonusDd: -0.055,
  },
  readings: READINGS,
};

/** GET /api/exposure payload: the REAL `computeExposure` over the mock F1/GT series (no hand-typed posture).
 *  It is the DEGRADED posture — mock F1 has < `ARM_MIN_OBS` closes and GT is unusable — so `equityPct`
 *  is null and /lab's footer cash chip paints only its "not yet sized" state in preview. */
const expF1 = SERIES.F1?.points ?? [];
const expGt = SERIES.GT?.points ?? [];
export const EXPOSURE = {
  ...computeExposure(expF1, expGt),
  asOf: [expF1.at(-1)?.date, expGt.at(-1)?.date].filter(Boolean).sort().at(-1) ?? null,
  thresholds: EXPOSURE_THRESHOLDS,
};

/** Alert-ladder history, newest-first, all OK (notify-only, nothing pushed). */
export function history(limit = 90) {
  const rows = [];
  for (let i = 0; i < limit; i++) rows.push({ date: dayStr(i), level: "OK", pushedAt: null });
  return rows; // already newest-first
}
