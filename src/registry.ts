/**
 * Indicator registry (the "what") — the cross-family assembly over the family split (2026-08-15).
 * Not a barrel: import a family's rows from its own file:
 *  - ./registry-fred.ts — `withMultipliedThresholds`, the INDICATORS FRED loop + knob
 *    constants, and the generic scoreIndicator-path ids (F7/ECY/EBP/HICP/R6).
 *  - ./registry-price.ts — bespoke price-scorer ids (F4/F5/SPCONC/F6/F8/F13/NVDA), the
 *    downside detectors + PRICE_SCORERS, and the SLOW/PENSION/BOTTOM track rows.
 *  - ./registry-composite.ts — multi-input composites (R7/CG/VT/VTP/EURC/BUND/CQS/BONOS/
 *    FXH/GT/GB/DISP) + the composite-component vintage machinery.
 *  - ./registry-geo.ts — G1/BRENT oil siblings + STAGE1_TRIGGER_IDS.
 * The cross-family assembly (ALL_INDICATORS, FACTOR_OF, ID_SETS/indicatorIds) stays HERE —
 * it composes every family, so no leaf can host it without a cycle.
 * (Top of the DAG unchanged: registry → scorers → domain.)
 */


import { type BackfillDepth, type Indicator } from "./domain-types.js";
import { type FamilyTag } from "./family-descriptor-core.js";
import {
  // Stage 3.1: the ID selector composes the census table (FAMILY_OF) with ALL_INDICATORS.
  FAMILY_OF,
} from "./family-descriptor-rows.js";
import { INDICATORS, F7, BBB, ECY, EBP, HICP, R6, CCC } from "./registry-fred.js";
import {
  F4,
  NVDA,
  F5,
  SPCONC,
  F6,
  F8,
  F13,
  DB_SMH,
  DB_XLK,
  RS_SMH,
  RS_XLK,
  KBE_RS,
  INS_RS,
  EXSH_GATE,
  MU_RS,
  JPT,
  AT1,
  DOWNSIDE_DETECTOR_IDS,
  SLOW_INDICATORS,
  PENSION_INDICATORS,
  BOTTOM_INDICATORS,
  PRICE_SCORERS,
} from "./registry-price.js";
import {
  R7,
  CG,
  VT,
  EURC,
  ESTR,
  EPATH,
  ECISS,
  EURGBP,
  BUND,
  CQS,
  BONOS,
  FXH,
  GT,
  GB,
  DISP,
  COMPOSITE_COMPONENTS,
  CHART_ONLY_INDICATORS,
} from "./registry-composite.js";
import { G1, BRENT, NG } from "./registry-geo.js";

/** Every indicator (FRED + price + geo + EBP + slow + pension) — backs /indicators metadata + /status labels. */
// Adding an id here (+ into the `readings` array) fans out to 3 mechanical sites or
// the suite reds: the `FRED_COUNT + N` reading-count asserts in run.wiring.test.ts and
// run.wiring.secondary-feeds.test.ts, and a
// public/indicator-desc.js `INDICATOR_DESC` entry (indicator-desc.test.js asserts
// every ALL_INDICATORS id has {tip,means,drives,derivation}). Once in both, a CONTEXT
// indicator auto-surfaces in /api + the notify BODY with no extra UI wiring.
export const ALL_INDICATORS: Indicator[] = [
  ...INDICATORS,
  // F4 and NVDA are listed adjacently on purpose: NVDA's close-vs-MA200 is F4's
  // Red gate, so the UI surfaces them side by side in the CONTEXT group. NVDA is
  // kept OUT of PRICE_INDICATORS (the [F4, F5] pair the bespoke scorers consume by
  // name) and spliced in here explicitly rather than spreading ...PRICE_INDICATORS.
  F4,
  NVDA,
  F5,
  // SPCONC: F5's broad-market twin (SPY/RSP). Same CONTEXT channel, same `trend` family,
  // same at-high scorer — F5 reads concentration inside the Nasdaq-100, SPCONC across the
  // whole S&P 500. Both ship until D5′-c picks one (deferred, needs SPCONC history).
  SPCONC,
  // F6/F8: trend-gate/soft semis-cycle members (CONTEXT, like NVDA — excluded from
  // every roll-up; the danger engine reads them off globalFamilies). Already scored +
  // persisted via PRICE_SCORERS; listed here so /api/indicators + /api/series surface
  // their metadata and the /lab reader detail-chart wires (needs an INDICATOR_DESC entry).
  F6,
  F8,
  // F13 HYG/LQD credit appetite — leading rate-clean credit member (CONTEXT, like F6/F8 —
  // excluded from every roll-up; the danger engine reads it off globalFamilies). Scored +
  // persisted via PRICE_SCORERS; listed here so /api/indicators + /api/series surface its
  // metadata and the /lab reader wires (needs an INDICATOR_DESC entry).
  F13,
  // DB_SMH: per-leg downside-break detector (drawdown-from-3mo-high + MA50 gate) over the SMH
  // semis proxy. GLOBAL channel (off every FIN/RATE roll-up — like the GT/GB/DISP/FXH/EURC
  // dial members). It is NOT a tech-confirmer slot member (`TECH_CONFIRMER_MEMBERS` is F4/F5,
  // t1dial.ts); its ONLY wiring is the WATCH-capped `ew` escalator floor (`EARLY_WARN_MEMBERS`).
  // Scored + persisted via DOWNSIDE_DETECTORS on the cron path; listed here so /api/indicators +
  // /api/series surface its metadata and the /lab reader detail-chart wires the drawdown graph.
  DB_SMH,
  // DB_XLK: the SAME detector on XLK (S&P 500 IT) — the direct read on the 100%-held pension
  // track (SP500IT coverage rung 1, 2026-07-23). GLOBAL channel, `ew`-floor only, in NO family.
  // Listed here so /api/indicators + /api/series surface its metadata and the /lab reader
  // detail-chart wires the same drawdown graph DB_SMH gets.
  DB_XLK,
  // RS_SMH/RS_XLK: the DB_* detectors' same-day rel-strength siblings (X/SPY vs its own MA50),
  // GLOBAL channel, no family — listed so /api/indicators + /api/series surface their metadata.
  RS_SMH,
  RS_XLK,
  // KBE_RS: bank-equity rel-strength (KBE/SPY vs MA50), F6-shape via PRICE_SCORERS. CONTEXT; seated uT
  // (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial.
  KBE_RS,
  // INS_RS: European-insurer rel-strength (EXH5.DE/EXSA.DE vs MA50), KBE_RS shape via PRICE_SCORERS. CONTEXT; seated uT
  // (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial.
  INS_RS,
  // EXSH_GATE: EU-Fin re-entry gate (EXSH.DE vs MA50/MA200 + EXSH.DE/EXSA.DE vs MA50, rule B) via PRICE_SCORERS.
  // CONTEXT; seated uT (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial.
  EXSH_GATE,
  // AT1: bank sub-credit proxy (XAT1.DE/EXHA.DE vs MA50), KBE_RS shape via PRICE_SCORERS. GLOBAL; seated cr
  // (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial.
  AT1,
  // MU_RS: Micron rel-strength (MU/SMH vs MA50), KBE_RS shape. CONTEXT, display-only (card-only, no weight/family).
  MU_RS,
  JPT, // Japan trend (1306.T vs MA200), GT shape via PRICE_SCORERS. CONTEXT, display-only (card-only, no weight/family).
  G1,
  BRENT, // crisis rung 3 — Brent crude confirm (GEO), scoreOil: 20d ROC band AND the trailing-peak level gate, FAST_CONFIRMERS tail
  NG, // Henry Hub natgas — CONTEXT, scoreOil (20d return + trailing-peak) via FAST_CONFIRMERS tail; off the alert band, no family/weight
  EBP,
  R6,
  R7,
  CG, // T2.2 copper/gold — CONTEXT confirmer, never solo, amplifies GEO only (UNVALIDATED, backtest-gated)
  VT, // T1.2 VIX term structure — pure CONTEXT, never touches the verdict (UNVALIDATED, backtest-gated)
  EURC, // slice 1b — euro-curve inversion, GLOBAL channel (off every roll-up; dial reads it), feeds the T1 dial's Rates family
  ESTR, // ESTR overnight-rate velocity (ECB EST), GLOBAL channel — EU-Fin policy-rate cut speed (eufin top5 N3)
  EPATH, // euro policy path SR_1Y − ESTR (meaned), GLOBAL channel, rowless context-only (estr-hike-side-leg R3)
  HICP, // euro-area HICP y/y Δ6m (FRED, monthly), CONTEXT channel, rowless display-only (estr-hike-side-leg R5)
  ECISS, // ECB composite CISS (euro area), CONTEXT channel, rowless display-only (eufin top5 C-block)
  EURGBP, // ECB EUR/GBP reference rate, CONTEXT channel, rowless display-only (eufin seat 10)
  BUND, // rung 3 — Bund curve 10y−2y (policy-PATH read), GLOBAL channel, joins EURC in the T1 dial's Rates family (§3.3 verdict ADD)
  CCC, // CCC & lower US HY OAS, GLOBAL channel, seated cr (all nine legs) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial
  BONOS, // Spanish−German 10y sovereign spread (sovereign-quote ES10Y-ES − DE10Y-DE), GLOBAL channel, seated in credit (contagion S2)

  FXH, // slice 1b — FX-haven composite, GLOBAL channel (off every roll-up; dial reads it), feeds the T1 dial's Flight family
  GT, // slice 1b — ACWI global trend, GLOBAL channel (isolated), re-points the T1 dial's Trend family
  GB, // slice 1b — global breadth participation, GLOBAL channel (isolated), re-points the T1 dial's Trend family
  DISP, // slice 1b — global dispersion (SPY·FEZ·EEM), GLOBAL channel (isolated), makes the T1 dial's Dispersion family live
  // CQS Baa−Aaa EBP-bridge — CONTEXT channel but a SEATED `GLOBAL_FAMILIES.credit` member since
  // 2026-08-16, so it has a `MEMBER_WEIGHT` row and moves the credit leg RAG (never the FIN roll-up).
  // Scored in run-cycle-feeds.ts off `baa10yTail` + `aaa10yTail` + a second degrade-wrapped `fetchEbp` (`ebpTail`);
  // never in INDICATORS. No CALIB_MAP entry — its cuts are hand-set, so there is no vintage to resolve.
  CQS,
  F7, // Shiller CAPE — VALUE-ONLY context card (never in INDICATORS, so never scored); value bridged read-time in api/status.ts. Overlay: cardGroupOf("F7")="valuation" (display card under Valuation; US_FAMILIES.valuation.ids stays []).
  BBB, // BBB OAS — value-only CONTEXT card (never in INDICATORS); INPUT_SERIES seeds it, cardGroupOf("BBB")="credit".
  ECY, // excess CAPE yield × GT trend gate — CONTEXT, scored by the FAST_CONFIRMERS tail off live CAPE + DFII10; level = trailing ECY z (2026-08-11)
  ...SLOW_INDICATORS,
  ...PENSION_INDICATORS,
  ...BOTTOM_INDICATORS,
];

/**
 * id → the registry's `geoFactor` tag — the ONE registry-derived factor map (R2, 2026-08-06).
 *
 * `diffusionLabel` (families.ts) and `autoGeoBase` (alert-band.ts) both collapse their counts over
 * DISTINCT FACTORS, so any caller that builds `computeFamilyPanel` rows from ids alone must thread
 * this or its printed breadth reverts to the pre-R2 per-member count. Lives HERE, beside
 * `ALL_INDICATORS`, because `families.ts` is registry-free by design and `api/lab.ts` (which first
 * spelled it) is a Vercel handler nothing else may import.
 *
 * Entries exist only for TAGGED ids; an absent `factor` makes the member its own factor
 * (`distinctFactorCount`, src/geo-factor.ts), which is the fail-loud direction — never quieter.
 */
export const FACTOR_OF: Readonly<Record<string, string>> = Object.fromEntries(
  ALL_INDICATORS.filter((i) => i.geoFactor !== undefined).map((i) => [i.id, i.geoFactor!]),
);

// --- Channel/scored-set ID selector (Stage 3.1, design §3.3) -----------------

/** The five scored `FamilyId`s — everything in `FAMILY_OF` that is not `"raw"`/`"context"`. */
const SCORED_TAGS: readonly FamilyTag[] = [
  "fred-level-velocity",
  "price-derived",
  "ratio-spread",
  "composite",
  "geo-hybrid",
];

/** Census lookup that FAILS LOUD: an `ALL_INDICATORS` id absent from `FAMILY_OF` throws at
 *  module load rather than being silently skipped out of `ID_SETS.scored` (the bijection
 *  test in family-descriptor.test.ts should make this unreachable — keep it loud anyway). */
function familyTagOf(id: string): FamilyTag {
  const tag = FAMILY_OF[id];
  if (tag === undefined) {
    throw new Error(
      `FAMILY_OF (family-descriptor-rows.ts) has no entry for indicator id "${id}" - ` +
        `every ALL_INDICATORS id must be censused before it can be classified scored/raw/context.`,
    );
  }
  return tag;
}

/** Channel/scored-set ID axes (design §3.3) — every list DERIVED from the registry's
 *  structural tables or FAMILY_OF; order = declaration order of the backing table.
 *  Note `VTP` is censused in FAMILY_OF but deliberately NOT in ALL_INDICATORS (EW-13,
 *  chart-only), so the `ALL_INDICATORS ∩ FAMILY_OF` composition excludes it automatically. */
export const ID_SETS = {
  all: ALL_INDICATORS.map((i) => i.id),
  scored: ALL_INDICATORS.filter((i) => SCORED_TAGS.includes(familyTagOf(i.id))).map((i) => i.id),
  raw: ALL_INDICATORS.filter((i) => familyTagOf(i.id) === "raw").map((i) => i.id),
  context: ALL_INDICATORS.filter((i) => familyTagOf(i.id) === "context").map((i) => i.id),
  fredLoop: INDICATORS.map((i) => i.id),
  priceScored: PRICE_SCORERS.map((s) => s.indicator.id),
  downside: DOWNSIDE_DETECTOR_IDS,
  cmp: Object.values(COMPOSITE_COMPONENTS).flat().map((c) => c.id),
} as const satisfies Record<string, readonly string[]>;
type IdSetName = keyof typeof ID_SETS;

/** Union of named sets minus exclusions; first-seen order, deduped. `exclude` entries MUST
 *  exist in the union (throws otherwise) so a retired id can't linger as a silent no-op. */
export function indicatorIds(
  sets: readonly IdSetName[],
  opts: { exclude?: readonly string[] } = {},
): readonly string[] {
  const union: string[] = [];
  const seen = new Set<string>();
  for (const name of sets) {
    for (const id of ID_SETS[name]) {
      if (!seen.has(id)) {
        seen.add(id);
        union.push(id);
      }
    }
  }
  const exclude = new Set<string>();
  for (const id of opts.exclude ?? []) {
    if (!seen.has(id)) {
      throw new Error(
        `indicatorIds: exclude id "${id}" is not in the union of [${sets.join(", ")}] - ` +
          `a retired/renamed id must be removed from the exclude list, not left as a silent no-op.`,
      );
    }
    exclude.add(id);
  }
  return union.filter((id) => !exclude.has(id));
}

/** The id's DECLARED seed depth (`Indicator.backfill`, served + chart-only rows), or undefined when it rides the shared default. */
export function depthFromRegistry(id: string): BackfillDepth | undefined {
  return [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].find((i) => i.id === id)?.backfill;
}
