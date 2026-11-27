/** Family-descriptor ROWS — descriptor literals, lookup maps, the `FAMILY_OF` census, derived legacy
 *  constants. Edit here; types live in `./family-descriptor-core.ts`. Runtime leaf (type-only imports). */
import {
  type FamilyTag,
  type FamilyChartParams,
  type FredFamilyDescriptor,
  type PriceDerivedDescriptor,
  type RatioSpreadDescriptor,
  type CompositeDescriptor,
  type GeoHybridDescriptor,
  type VelocityMeasure,
  tradingToCalendarDays,
} from "./family-descriptor-core.js";

/** Synth-prior expanding-percentile cuts (both axes) — owned HERE so F3's labels single-source them;
 *  `synth-cuts` re-exports. NOT in `synth-cuts`: that closes the `→ synth-cuts → slow` cycle. */
export const SYNTH_AMBER_PCTILE = 0.85;
export const SYNTH_RED_PCTILE = 0.95;


/** Census: every scored/persisted id → its family (or raw/context), exactly once. Pinned bijectively
 *  against the prod id universe by `family-descriptor.test.ts`. */
export const FAMILY_OF: Readonly<Record<string, FamilyTag>> = {
  // fred-level-velocity — generic FRED/velocity classify family
  F1: "fred-level-velocity",
  F2: "fred-level-velocity",
  F3: "fred-level-velocity",
  R1: "fred-level-velocity",
  R8: "fred-level-velocity", // fixed level pair (R1 shape) over `SMOOTHED_LEVEL_OF.R8`'s mean
  R2: "fred-level-velocity",
  R3: "fred-level-velocity",
  R4: "fred-level-velocity",
  R5: "fred-level-velocity",
  F9: "fred-level-velocity",
  F10: "fred-level-velocity",
  F11: "fred-level-velocity",
  EBP: "fred-level-velocity",
  R6: "composite", // scored by scoreMoveLevel (R6_DESCRIPTOR), not the generic FRED route
  CCC: "fred-level-velocity", // FRED BAMLH0A3HYC, hand-set level + Δ20 pairs
  T10YIE: "fred-level-velocity", // 10y breakeven — level AND velocity (dualAxis below)
  T5YIFR: "fred-level-velocity", // 5y5y forward inflation — level+velocity; both in DUAL_AXIS_IDS
  // price-derived — bespoke price scorers
  F4: "price-derived",
  F5: "price-derived",
  F6: "price-derived",
  F8: "price-derived",
  F13: "price-derived",
  NVDA: "price-derived",
  SPCONC: "price-derived",
  DB_SMH: "price-derived", // scoreDownsideBreak (scorer escape hatch)
  DB_XLK: "price-derived", // scoreDownsideBreak (scorer escape hatch)
  RS_SMH: "price-derived", // scoreRelStrengthBreak over SMH/SPY (scorer escape hatch)
  RS_XLK: "price-derived", // scoreRelStrengthBreak over XLK/SPY (scorer escape hatch)
  KBE_RS: "price-derived", // scoreRelStrengthBreak over KBE/SPY (scorer escape hatch)
  INS_RS: "price-derived", // scoreRelStrengthBreak over EXH5.DE/EXSA.DE (scorer escape hatch)
  EXSH_GATE: "price-derived", // exshGateReadingSeries over EXSH.DE/EXSA.DE (3-check rule B, EXSH_GATE_DESCRIPTOR)
  AT1: "price-derived", // scoreRelStrengthBreak over XAT1.DE/EXHA.DE (scorer escape hatch)
  MU_RS: "price-derived", // scoreRelStrengthBreak over MU/SMH (scorer escape hatch)
  JPT: "price-derived", // globalTrendReadingSeries over 1306.T (GT shape, GT_AMBER/GT_RED)
  HCX: "price-derived", // chart-only (CHART_ONLY_INDICATORS): capex basket ÷ SPY, breadth-LOW scorer
  FDX: "price-derived", // chart-only (CHART_ONLY_INDICATORS): TSM/SMH ratio, scoreRatioVsMa
  // ratio-spread — two-input ratio/spread scorers
  CG: "ratio-spread",
  VT: "ratio-spread",
  EURC: "ratio-spread",
  EPATH: "ratio-spread",
  BUND: "ratio-spread",
  // composite — multi-input CMP_* composites
  R7: "composite", // scoreBullSteepener via BespokeRef — 3-series 2-D dominance state
  FXH: "composite",
  GT: "composite",
  GB: "composite",
  DISP: "composite",
  VTP: "composite", // scoreVixTermPersistence via BespokeRef — streak-banded, no CONFIRM_CLOSES fold
  CQS: "composite", // Baa−Aaa quality spread; NOT "ratio-spread" (that fires LOW while a widening spread is the HIGH risk)
  BONOS: "composite", // Bonos−Bund 10y spread, HIGH-firing — the CQS-class reason it is NOT "ratio-spread"
  ECY: "composite", // excess CAPE yield × GT gate; scoreEcy via BespokeRef, danger seat vb in families.ts
  // geo-hybrid
  G1: "geo-hybrid",
  OVX: "geo-hybrid", // scoreOil — FIXED level band OR a 5-session spike
  BRENT: "geo-hybrid", // bespoke scoreOil — 20d ROC band AND trailing-peak level gate
  NG: "geo-hybrid", // Henry Hub natgas — scoreOil twin of G1/BRENT; CONTEXT channel, off the alert band
  // context — never scored by a family scorer
  F7: "context",
  // raw — SLOW_INDICATORS (off-ladder display/persist, no threshold semantics)
  "price-accel": "raw",
  "complacency-vix": "raw",
  "complacency-high": "raw",
  "complacency-duration": "raw",
  // raw — PENSION_INDICATORS
  SPY: "raw",
  DEXUSEU: "raw",
  SP500IT: "raw",
  LEGP_EUFIN: "raw", // held EU-Fin sleeve, chained EUR level (scoreboard-owned store series)
  LEGP_HEALTH: "raw", // Health sleeve, chained EUR level (scoreboard-owned store series)
  LEGP_COMMOD: "raw", // off-ladder commodities detail row, chained EUR level (LYTR.DE, scoreboard-owned)
  LEGP_RAFI: "raw", // off-ladder AW-Fundamental detail row, chained EUR level (PSWD.DE, scoreboard-owned)
  // the remaining ladder legs, chained EUR level (`legCloseId`, scoreboard-owned store series)
  LEGP_SEMIS: "raw",
  LEGP_SPIT: "raw",
  LEGP_EM: "raw",
  LEGP_SPX: "raw",
  LEGP_EXUS: "raw",
  LEGP_STAPLES: "raw",
  // comparator legs (same PENSION channel, unweighted — display-only)
  VWO: "raw",
  VGK: "raw",
  XDEV: "raw",
  KBE: "raw", // value-ladder input
  HYNIX: "raw", // value-ladder display-only comparator, 000660.KS
  AMAT: "raw", // value-ladder display-only comparator
  KRW: "raw", // value-ladder display-only comparator, KRW=X
  COPPER: "raw", // value-ladder display-only comparator, HG=F
  BBB: "raw", // value-only CONTEXT card, FRED BAMLC0A4CBBB via INPUT_SERIES
  // raw — BOTTOM_INDICATORS
  VIX: "raw",
  VIX3M: "raw",
  T10Y3M_RAW: "raw", // chart-only (CHART_ONLY_INDICATORS): FRED T10Y3M level unsmoothed, `thresholds: {}`
  VXNCLS: "raw", // chart-only (CHART_ONLY_INDICATORS): VXNCLS level, `thresholds: {}` like the BOTTOM VIX row
  VXSMH: "raw", // chart-only (CHART_ONLY_INDICATORS): VXSMH level, `thresholds: {}`
  F17: "fred-level-velocity",
  ESTR: "composite", // generic `derived` "change" scorer (scoreDerived) over the ECB ESTR feed — GT precedent
  ECISS: "fred-level-velocity", // generic classify over the ECB CISS feed; CONTEXT, rowless (eufin top5 C2)
  EURGBP: "composite", // scoreReturnOrMaSpread over the ECB EXR feed; CONTEXT, rowless (eufin seat 10)
  HICP: "fred-level-velocity", // generic level classify over `hicpDelta6m` (FRED HICP); CONTEXT, rowless (estr-hike R5)
  VXNT: "ratio-spread", // chart-only (CHART_ONLY_INDICATORS): VXNCLS ÷ (VXVCLS × k) on VXNT_DESCRIPTOR — VT's cuts
  // new-indicator:FAMILY_OF-END
};

// --- ratio/spread descriptors (CG · VT · VXNT · EURC · EPATH · BUND). Each cut pair here is the ONE source; the
// legacy constant names below are DERIVED, never restated. CG omits `window` — never restate `20`. ---

/** CG copper/gold — velocity (20d return, DROP is the signal) + detrended-percentile level, combine
 *  "split" (RED needs both). Cuts here are the ONE source (`POINT_BAND_CUTS_OF.CG` derives them); never restate. */
export const CG_DESCRIPTOR = {
  family: "ratio-spread",
  inputs: ["HG=F", "GC=F"],
  cutKind: "return",
  amber: -0.01,
  red: -0.03,
  levelBand: { kind: "detrended-expanding-percentile", trendWindow: 80, amberP: 0.3, redP: 0.1 },
  combine: "split",
} as const satisfies RatioSpreadDescriptor;

/** Per-point velocity cuts for any rolling-σ id (`velocitySigma`; F9, F11) — σ MULTIPLE never stated
 *  here, `from` names the registry `Thresholds` field; wire units are RAW velocity (Δw), not σ. */
export const POINT_BAND_SIGMA_CUTS: ReadonlyArray<{
  level: "amber" | "red";
  key: string;
  from: "amberVelocity" | "redVelocity";
}> = [
  { level: "amber", key: "velSigmaAmber", from: "amberVelocity" },
  { level: "red", key: "velSigmaRed", from: "redVelocity" },
];
/** Wire key of the display-only `dualAxis.refSigma` line (`refSigma · σ(t)`, raw Δw units). */
export const SIGMA_REF_KEY = "velSigmaRef";

/** VT VIX/VIX3M term-structure ratio LEVEL — RISING (curve inverting) is the risk, direction HIGH.
 *  RED edge STRICT (`>`), AMBER inclusive (`≥`). The pair below is the SINGLE source; never restate it. */
export const VT_DESCRIPTOR = {
  family: "ratio-spread",
  // FRED ids (were the closes feed's ^VIX/^VIX3M until 2026-07-26).
  inputs: ["VIXCLS", "VXVCLS"],
  cutKind: "level",
  amber: 0.93,
  red: 0.97,
} as const satisfies RatioSpreadDescriptor;

/** Aligned VXNCLS∩VIXCLS closes strictly before the scored day that `k` medians over; fewer ⇒ no reading. */
export const VXNT_K_WINDOW = 250;

/** VXNT = VXNCLS ÷ (VXVCLS × k). Cuts ARE VT's — retuning VT retunes VXNT; never restate. */
export const VXNT_DESCRIPTOR = {
  family: "ratio-spread",
  inputs: ["VXNCLS", "VXVCLS"],
  cutKind: "level",
  amber: VT_DESCRIPTOR.amber,
  red: VT_DESCRIPTOR.red,
} as const satisfies RatioSpreadDescriptor;

/** EURC ECB euro-curve spread SR_10Y − SR_3M, LEVEL, direction LOW (mirror US R1). Both edges strict
 *  (`<`). red 0.0 is IMMOVABLE under `earlierCut`'s |v|-relative form (a nonzero amber sibling still moves). */
export const EURC_DESCRIPTOR = {
  family: "ratio-spread",
  inputs: ["SR_10Y", "SR_3M"],
  cutKind: "spread",
  amber: 0.5,
  red: 0.0,
} as const satisfies RatioSpreadDescriptor;

/** EPATH euro policy-path spread SR_1Y − ESTR, direction HIGH (a priced hike path is the risk), scored and
 *  persisted as the `meanWindow` mean. */
export const EPATH_DESCRIPTOR = {
  family: "ratio-spread",
  inputs: ["SR_1Y", "ESTR"],
  cutKind: "spread",
  direction: "HIGH",
  amber: 0.25,
  red: 0.75,
  meanWindow: 10,
} as const satisfies RatioSpreadDescriptor;

/** BUND Bund 10y−2y slope — `scoreCurve`, worst-of legs (a)/(b)/(c). `amber` = leg (b)'s ONE level cut (→ REACHABLE_IDS);
 *  `red` is CONTEXT-ONLY (the shape requires it; no leg reads it — a BUND `redMult` throws, threshold-config.ts). */
export const BUND_DESCRIPTOR = {
  family: "ratio-spread",
  inputs: ["DE10Y", "DE2Y"],
  cutKind: "spread",
  amber: 0.35,
  red: -0.03,
  scorer: {
    ref: "scoreCurve",
    // (a) |Δ VELOCITY_WINDOW slope| pp, either sign · (c) 2y Δ fall pp while slope < 0 within `escWindow` obs.
    constants: { velAmber: 0.2, velRed: 0.3, escDrop2y: 0.3, escWindow: 60 },
  },
  // Builder escape hatch (`buildCurveChart`): the level context line + ±velAmber/±velRed on the Δ axis.
  chart: { builder: { ref: "buildCurveChart", constants: {} } },
} as const satisfies RatioSpreadDescriptor;

/** id → curve descriptor, the `scoreCurve`/`buildCurveChart` pair's lookup. References the instances above. */
export const CURVE_DESCRIPTOR_OF = { BUND: BUND_DESCRIPTOR } as const;

/** SMOOTHED-LEVEL ids — registry `thresholds` level pair over a trailing MEAN; `scoreWithCuts`
 *  (confirmers.ts) branches on membership, `window` in OBSERVATIONS. The mean is PERSISTED as `value`. */
export const SMOOTHED_LEVEL_OF: Readonly<Record<string, { window: number; redWindow?: number }>> = {
  R8: { window: 21 }, // 21 business days ≈ one month — the term-spread probit sampling grid, not a tunable
  // R1 (ruled 2026-08-31, `npm run probe:r1-lit`): AMBER on the 21-obs mean (Estrella–Trubin monthly),
  // RED on the 63-obs mean (Harvey quarterly) — both literature-fixed, never retune by sweep.
  R1: { window: 21, redWindow: 63 },
};

/** id → ratio-spread descriptor, the chart rail's family route (src/chart-rail.ts). References the
 *  instances above, never restates them. CG never reaches the ratio route (its registry `derived` wins first). */
export const RATIO_DESCRIPTOR_OF: Readonly<Record<string, RatioSpreadDescriptor>> = {
  CG: CG_DESCRIPTOR,
  VT: VT_DESCRIPTOR,
  VXNT: VXNT_DESCRIPTOR,
  EURC: EURC_DESCRIPTOR,
  EPATH: EPATH_DESCRIPTOR,
  BUND: BUND_DESCRIPTOR,
};

// Legacy names, DERIVED (never restated):
export const CG_AMBER_RET = CG_DESCRIPTOR.amber;
export const CG_RED_RET = CG_DESCRIPTOR.red;
export const VT_AMBER_RATIO = VT_DESCRIPTOR.amber;
export const VT_RED_RATIO = VT_DESCRIPTOR.red;
export const EURC_AMBER = EURC_DESCRIPTOR.amber;
export const EURC_RED = EURC_DESCRIPTOR.red;
export const BUND_AMBER = BUND_DESCRIPTOR.amber;
export const BUND_RED = BUND_DESCRIPTOR.red;

// --- bespoke-scorer descriptors (G1 · F4 · F6 · F8) — TUNABLES only, via the `BespokeRef` escape
// hatch; legacy constant names below are DERIVED, never restated. ---

/** Oil LEVEL-gate lookback, TRADING days (756 ≈ 3y) — SHARED by G1 and BRENT (one macro construct,
 *  Hamilton's net-oil-price-increase; two copies = two touch points). */
const OIL_LEVEL_WINDOW = 756;

/** Graded level leg's AMBER rung: price ≥ this fraction of the trailing peak (user-set off the detail
 *  chart). Shared by G1 and BRENT like `OIL_LEVEL_WINDOW` — one retune touch point. */
const OIL_PEAK_PROXIMITY = 0.95;

/** Calendar days the oil feeds must fetch so the 756-TRADING-day level gate resolves — DERIVED from
 *  `OIL_LEVEL_WINDOW`. Too short and the level leg is silently PERMANENT-GREEN (split RED unreachable). */
export const OIL_LEVEL_LOOKBACK_DAYS = tradingToCalendarDays(OIL_LEVEL_WINDOW) + 180;


/** G1/WTI oil shock — VELOCITY (20d return, Amber ≥ +20%, Red ≥ +40%) + graded trailing-peak LEVEL,
 *  combine "split" (RED needs both, AMBER off either). */
export const G1_DESCRIPTOR = {
  family: "geo-hybrid",
  combine: "split",
  level: "trailing-peak",
  scorer: {
    ref: "scoreOil",
    constants: { amberRet: 0.2, redRet: 0.4, levelWindow: OIL_LEVEL_WINDOW, peakProximity: OIL_PEAK_PROXIMITY },
  },
} as const satisfies GeoHybridDescriptor;

/** BRENT crude confirm — VELOCITY (20d ROC as FRACTIONS: Amber ≥ +15%, Red ≥ +25%) + the trailing-peak
 *  LEVEL gate, combine "split". No fixed-dollar level cut (a $100 disjunct was retired: not scale-invariant). */
export const BRENT_DESCRIPTOR = {
  family: "geo-hybrid",
  combine: "split",
  level: "trailing-peak",
  scorer: {
    ref: "scoreOil",
    constants: { amberRoc: 0.15, redRoc: 0.25, levelWindow: OIL_LEVEL_WINDOW, peakProximity: OIL_PEAK_PROXIMITY },
  },
} as const satisfies GeoHybridDescriptor;

/** NG Henry Hub natural gas — scoreOil twin of G1: VELOCITY (20d return) + graded trailing-peak LEVEL,
 *  combine "split". [USER] 2026-09-22 AGGRESSIVE cuts amberRet 0.25 / redRet 0.5; shares the oil windows. */
export const NG_DESCRIPTOR = {
  family: "geo-hybrid",
  combine: "split",
  level: "trailing-peak",
  scorer: {
    ref: "scoreOil",
    constants: { amberRet: 0.25, redRet: 0.5, levelWindow: OIL_LEVEL_WINDOW, peakProximity: OIL_PEAK_PROXIMITY },
  },
} as const satisfies GeoHybridDescriptor;

/** OVX crude implied vol — LEVEL `fixed` (registry `thresholds` pair, no CALIB_MAP) + a VELOCITY SPIKE
 *  (`velocityWindow` sessions), combine "or" (worst-of, so the level band keeps its full severity range). */
export const OVX_DESCRIPTOR = {
  family: "geo-hybrid",
  combine: "or",
  level: "fixed",
  scorer: { ref: "scoreOil", constants: { amberRet: 0.24, redRet: 0.35, velocityWindow: 5 } },
} as const satisfies GeoHybridDescriptor;

/** Oil-family descriptors BY ID — the lookup `scoreOil` reads. Pinned against `FAMILY_OF`'s "geo-hybrid"
 *  rows by `family-golden.test.ts` (a fourth oil id without a row here fails the suite). */
export const GEO_HYBRID_DESCRIPTOR_OF: Readonly<Record<string, GeoHybridDescriptor>> = {
  G1: G1_DESCRIPTOR,
  OVX: OVX_DESCRIPTOR,
  BRENT: BRENT_DESCRIPTOR,
  NG: NG_DESCRIPTOR,
};

/** F4 6-mo return thresholds (v4 §4): Amber ≤ −15%, Red ≤ −25%. */
export const F4_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreSemis", constants: { amberRet: -0.15, redRet: -0.25 } },
} as const satisfies PriceDerivedDescriptor;

/** F8 Micron memory-cycle (MU) — momentum gate, LOW-is-bad (bands written in effective positive form:
 *  +120% amber / +100% red). `maMult` = MA200 gate headroom (`MU < MA200(MU)·maMult`). SINGLE source. */
export const F8_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreMemGate", constants: { amber: 1.2, red: 1.0, maMult: 1.1 } },
} as const satisfies PriceDerivedDescriptor;

// Legacy names, DERIVED (never restated):
export const G1_AMBER_RET = G1_DESCRIPTOR.scorer.constants.amberRet;
export const G1_RED_RET = G1_DESCRIPTOR.scorer.constants.redRet;
export const BRENT_AMBER_ROC = BRENT_DESCRIPTOR.scorer.constants.amberRoc;
export const BRENT_RED_ROC = BRENT_DESCRIPTOR.scorer.constants.redRoc;
export const NG_AMBER_RET = NG_DESCRIPTOR.scorer.constants.amberRet;
export const NG_RED_RET = NG_DESCRIPTOR.scorer.constants.redRet;
export const F4_AMBER_RET = F4_DESCRIPTOR.scorer.constants.amberRet;
export const F4_RED_RET = F4_DESCRIPTOR.scorer.constants.redRet;
export const MU_AMBER = F8_DESCRIPTOR.scorer.constants.amber;
export const MU_RED = F8_DESCRIPTOR.scorer.constants.red;
export const MU_MA_MULT = F8_DESCRIPTOR.scorer.constants.maMult;

// --- shared price windows + F13 + DB_* downside detectors ---

/** Price-scorer trailing windows (trading days), SHARED, legacy names derived off it (`ma`=MA200,
 *  `ret`=6-mo, `high`=12-mo, `highShort`=3-mo, `maShort`=MA50). `HYGLQD_MA` NOT a member (F13-owned). */
export const PRICE_WINDOWS = { ma: 200, ret: 126, high: 252, highShort: 63, maShort: 50 } as const;

/** Per-indicator breadth-band config (`breadthReadingSeries`): high window, two cut PROBABILITIES,
 *  rolling percentile window + minObs, firing `direction` ("high" = near a 12-mo high is the risk; "low" = mirror). */
export interface BreadthConfig {
  readonly highWindow: number;
  readonly amberP: number;
  readonly redP: number;
  readonly cutWindow: number;
  readonly minObs: number;
  readonly direction: "high" | "low";
}
/** F5's breadth band — the ONE source of its cut pair/window/HIGH firing; `BREADTH_*` names derived.
 *  SPCONC no longer shares it (F5 alone took the rolling-63 retune). */
export const BREADTH_BAND: BreadthConfig = {
  highWindow: PRICE_WINDOWS.high,
  amberP: 0.88,
  redP: 0.985,
  cutWindow: 63,
  minObs: 63,
  direction: "high",
};
/** SPCONC's breadth band — F5's pre-retune triple, HELD when F5 split off. ⚠ A CONTROL for F5's
 *  shorter window — do not re-merge the two. */
const SPCONC_BAND: BreadthConfig = {
  highWindow: PRICE_WINDOWS.high,
  amberP: 0.85,
  redP: 0.98,
  cutWindow: 126,
  minObs: 126,
  direction: "high",
};
/** HCX capex basket — LOW twin of the HIGH breadth bands (rolling-126, 252 high, direction "low"),
 *  CHART-ONLY; hand-set off a measured cut probe. ⚠ Judge a pair on the SEPARATION of its two cuts, not fire rate. */
export const HCX_BAND: BreadthConfig = {
  highWindow: PRICE_WINDOWS.high,
  amberP: 0.25,
  redP: 0.08,
  cutWindow: 126,
  minObs: 126,
  direction: "low",
};
/** Which id resolves which breadth config — every band seats its own; no id shares another's. */
export const BREADTH_CONFIG_OF: Readonly<Record<string, BreadthConfig>> = {
  F5: BREADTH_BAND,
  SPCONC: SPCONC_BAND,
  HCX: HCX_BAND,
};
export const BREADTH_AMBER_P = BREADTH_BAND.amberP;
export const BREADTH_RED_P = BREADTH_BAND.redP;
export const BREADTH_CUT_WINDOW = BREADTH_BAND.cutWindow;
/** The DEEPEST cut window any breadth id needs — `BREADTH_MIN_CLOSES` (one shared floor for every
 *  breadth row) derives off this, so a per-id window change can never under-feed a sibling. */
export const BREADTH_MAX_CUT_WINDOW = Math.max(
  ...Object.values(BREADTH_CONFIG_OF).map((c) => c.cutWindow),
);

/** F13 HYG/LQD credit appetite — TWO legs over HYG÷LQD, both LOW-is-bad: `d20` (fast return) + `ms50`
 *  (%-vs-MA`maWindow`), combine `"split"` (RED both, AMBER either). SINGLE source; ⚠ `amber` is `-0.0`. Truth table: dashboard.price-scorers.test.ts. */
export const F13_DESCRIPTOR = {
  family: "price-derived",
  scorer: {
    ref: "scoreCreditAppetite",
    constants: { maWindow: 50, amber: -0.0, red: -0.006, retWindow: 20, d20Amber: -0.005, d20Red: -0.009 },
  },
} as const satisfies PriceDerivedDescriptor;

/** Per-indicator config for the generic ratio-vs-MA scorer (`ratioVsMaReadingSeries`): MA window + ms50
 *  pair + Δ`retWindow` velocity pair. F13's row IS its `scorer.constants`. `maWindow>retWindow` asserted at load. */
export interface RatioVsMaConfig {
  readonly maWindow: number;
  readonly amber: number;
  readonly red: number;
  readonly retWindow: number;
  readonly d20Amber: number;
  readonly d20Red: number;
}

/** FDX TSM÷SMH foundry-dependency — same two-leg ratio-vs-MA shape as F13, LOW-is-bad, CHART-ONLY;
 *  cuts hand-set off a measured cut probe. ⚠ Never port a fraction from F13 (different daily scale). */
export const FDX_DESCRIPTOR = {
  family: "price-derived",
  scorer: {
    ref: "scoreRatioVsMa",
    constants: { maWindow: 50, amber: -0.02, red: -0.07, retWindow: 20, d20Amber: -0.02, d20Red: -0.06 },
  },
} as const satisfies PriceDerivedDescriptor;

export const RATIO_VS_MA_CONFIG_OF: Readonly<Record<string, RatioVsMaConfig>> = {
  F13: F13_DESCRIPTOR.scorer.constants,
  FDX: FDX_DESCRIPTOR.scorer.constants,
};

/** A SECOND scorer leg needing its own line on the derived route, keyed by id. ⚠ Only valid where the
 *  plotted PRIMARY `value` IS the scored series; cut pair is the RAW descriptor constant (no `resolveBands`). */
export interface SecondLegChart {
  compute: "trailingReturn";
  window: number;
  amber: number;
  red: number;
  /** Legend/readout name for the second line. */
  label: string;
  /** Short band tag for the SECOND leg's cut pair. */
  tag: string;
  /** Short band tag for the FIRST (`derived`) leg's pair. */
  siblingTag: string;
}
export const SECOND_LEG_CHART_OF: Readonly<Record<string, SecondLegChart>> = {
  F13: {
    compute: "trailingReturn",
    window: F13_DESCRIPTOR.scorer.constants.retWindow,
    amber: F13_DESCRIPTOR.scorer.constants.d20Amber,
    red: F13_DESCRIPTOR.scorer.constants.d20Red,
    label: `HYG/LQD Δ${F13_DESCRIPTOR.scorer.constants.retWindow}d`,
    tag: `Δ${F13_DESCRIPTOR.scorer.constants.retWindow}d`,
    siblingTag: "vs MA50",
  },
  // FDX — same shape as F13; every number off FDX_DESCRIPTOR, never restated.
  FDX: {
    compute: "trailingReturn",
    window: FDX_DESCRIPTOR.scorer.constants.retWindow,
    amber: FDX_DESCRIPTOR.scorer.constants.d20Amber,
    red: FDX_DESCRIPTOR.scorer.constants.d20Red,
    label: `TSM/SMH Δ${FDX_DESCRIPTOR.scorer.constants.retWindow}d`,
    tag: `Δ${FDX_DESCRIPTOR.scorer.constants.retWindow}d`,
    siblingTag: "vs MA50",
  },
};

/** DB_SMH downside break — the DEFAULT drawdown pair, taken by every detector without a
 *  `DOWNSIDE_CUT_OVERRIDES` row. UNCALIBRATED priors; consumer is the WATCH-capped `ew` escalator floor. */
export const DB_SMH_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreDownsideBreak", constants: { amber: -0.05, red: -0.08 } },
} as const satisfies PriceDerivedDescriptor;

/** DB_XLK's OWN cuts — a separate descriptor (numerically equal to the default today), kept separate so
 *  either detector retunes alone; per-id ROUTING pinned by dashboard.price-scorers.test.ts. */
export const DB_XLK_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreDownsideBreak", constants: { amber: -0.05, red: -0.08 } },
} as const satisfies PriceDerivedDescriptor;

/** Per-id cut overrides; an absent id takes the DB_SMH default. A test pins DB_XLK has a ROW (else
 *  emptying is undetectable while constants equal the default). DERIVED off `DB_XLK_DESCRIPTOR`. */
export const DOWNSIDE_CUT_OVERRIDES: Readonly<Record<string, Readonly<{ amber: number; red: number }>>> = {
  DB_XLK: { amber: DB_XLK_DESCRIPTOR.scorer.constants.amber, red: DB_XLK_DESCRIPTOR.scorer.constants.red },
};

/** RS_SMH rel-strength breakdown — DEFAULT %-spread pair (ratio X/SPY vs its trailing MA`maWindow`),
 *  LOW-is-bad. STARTING PRIORS — uncalibrated. */
export const RS_SMH_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreRelStrengthBreak", constants: { maWindow: PRICE_WINDOWS.maShort, amber: 0, red: -0.03 } },
} as const satisfies PriceDerivedDescriptor;

/** RS_XLK's OWN pair — equal to the default today, kept separate so either leg retunes alone;
 *  per-id ROUTING pinned via `rsCuts`' injected-table test. */
export const RS_XLK_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreRelStrengthBreak", constants: { maWindow: PRICE_WINDOWS.maShort, amber: 0, red: -0.03 } },
} as const satisfies PriceDerivedDescriptor;

/** KBE_RS bank-equity rel-strength — cuts [USER]-hand-set 2026-09-24 off the prod detail series (was
 *  RS_SMH-derived 0/-0.03 = AMBER+ 52.6% / RED 22.6% of days,
 *  a coin-flip amber). Red ≈ p5, amber ≈ p22 of the spread. Fed through `RS_CUT_OVERRIDES` below. */
export const KBE_RS_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreRelStrengthBreak", constants: { maWindow: PRICE_WINDOWS.maShort, amber: -0.03, red: -0.06 } },
} as const satisfies PriceDerivedDescriptor;

/** INS_RS European-insurer rel-strength (EXH5.DE/EXSA.DE) —
 *  cuts DEFAULTED to KBE_RS's pair 2026-10-08, pending a [USER] re-eye off the prod detail series.
 *  Own row, not a KBE_RS alias (either retunes alone). Fed through
 *  `RS_CUT_OVERRIDES` below. */
export const INS_RS_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreRelStrengthBreak", constants: { maWindow: PRICE_WINDOWS.maShort, amber: -0.03, red: -0.06 } },
} as const satisfies PriceDerivedDescriptor;

/** EXSH_GATE — the held EU-Fin fund's re-entry gate ([USER] rule B, ruled 2026-10-06; criteria from
 *  the France overlay). Retires the EXSH rel-strength + MA200-trend
 *  rows into one. Three PURE CROSSES, each a spread `x ÷ its trailing MA − 1` against the cut below:
 *   - RED   iff EXSH close vs its MA`trendWindow` is at/below `red` (the research's "never closed < MA200");
 *   - else AMBER iff EXSH close vs its MA`maShortWindow` is at/below `amberMa`
 *               OR the EXSH/EXSA ratio vs its own MA`rsWindow` is at/below `amberRs`;
 *   - else GREEN. The MA200 check takes precedence over the other two.
 *  Edges are INCLUSIVE on all three (`spread ≤ cut` fires), the retired trend row's convention and `classifyDerived`'s
 *  LOW branch: a close sitting exactly ON a line counts as the cross (a card warns on touch).
 *  The SINGLE source — the registry `derived` band, the scorer and the tests read these by reference.
 *  ⚠ The MA200 RED check needs EXSA.DE too: a failed EXSA fetch drops the whole row; MAs count date-joined closes. */
export const EXSH_GATE_DESCRIPTOR = {
  family: "price-derived",
  scorer: {
    ref: "exshGateReadingSeries",
    constants: {
      trendWindow: PRICE_WINDOWS.ma,
      red: 0,
      maShortWindow: PRICE_WINDOWS.maShort,
      amberMa: 0,
      rsWindow: PRICE_WINDOWS.maShort,
      amberRs: 0,
    },
  },
} as const satisfies PriceDerivedDescriptor;

/** The `/value` XDEV ladder's windows/cuts, read by `VALUE_RULES`
 *  (`scripts/probe-value-tranches.ts`) and `TOGGLE_OVERLAYS.XDEV`/`RV10_WINDOW` (chart-rail.ts).
 *  A retune moves the `/value` verdict too — re-run `npm run probe:value-tranches` after editing a constant. */
export const XDEV_GATE_DESCRIPTOR = {
  scorer: {
    constants: {
      highWindow: 60,
      maWindow: PRICE_WINDOWS.maShort,
      zoneOpen: 0.03,
      zoneT2: 0.05,
      zoneT3: 0.08,
      rvWindow: 10,
      rvOffPeak: 0.2,
      sigmaWindow: 60,
      t2RvMult: 1.5,
      rvSlowWindow: 20,
      t3RvMult: 1.2,
      lowWindow: 5,
      vetoSd: 3,
      vetoWindow: 5,
      muVetoCap: 0.08,
    },
  },
} as const;

/** AT1 bank sub-credit proxy (XAT1.DE/EXHA.DE, btp-bund S4) — cuts [USER]-hand-set 2026-09-24 off the prod series
 *  (re-cut [USER] 2026-09-26, eufin-overlap R10; re-cut again [USER] 2026-09-29, AT1 scorer review — loosened, supersedes R10's
 *  bank-capital-only RED; kept [USER] 2026-10-11 on the EXHA re-base: `docs/indicator-cut-provenance.md` §AT1). Own row, not a KBE_RS
 *  alias (either retunes alone). Fed through `RS_CUT_OVERRIDES`. */
export const AT1_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreRelStrengthBreak", constants: { maWindow: PRICE_WINDOWS.maShort, amber: -0.004, red: -0.012 } },
} as const satisfies PriceDerivedDescriptor;

/** F6 SMH/SPY — level-free MA200 trend gate: RED iff the ratio closes below its trailing MA`maWindow`;
 *  `amber: null` ⇒ no AMBER leg. Cuts: `docs/indicator-cut-provenance.md` §F6. */
export const F6_DESCRIPTOR = {
  family: "price-derived",
  scorer: { ref: "scoreRelStrengthBreak", constants: { maWindow: PRICE_WINDOWS.ma, amber: null, red: 0 } },
} as const satisfies PriceDerivedDescriptor;

/** One `scoreRelStrengthBreak` parameter row: the MA window + the cut pair (a null leg never fires). */
export type RsCuts = Readonly<{ maWindow: number; amber: number | null; red: number | null }>;

/** Per-id RS rows (`DOWNSIDE_CUT_OVERRIDES` pattern): an absent id takes RS_SMH. DERIVED off the
 *  descriptors; consumed by `rsCuts()` below. */
export const RS_CUT_OVERRIDES: Readonly<Record<string, RsCuts>> = {
  RS_XLK: RS_XLK_DESCRIPTOR.scorer.constants,
  F6: F6_DESCRIPTOR.scorer.constants,
  KBE_RS: KBE_RS_DESCRIPTOR.scorer.constants,
  INS_RS: INS_RS_DESCRIPTOR.scorer.constants,
  AT1: AT1_DESCRIPTOR.scorer.constants,
};

/**
 * The parameter row for a rel-strength id (RS_* legs, F6): the `overrides` entry when present,
 * else the default (RS_SMH) row — the `downsideCuts` pattern, `Object.hasOwn` for the same
 * prototype reason. `overrides` is injectable for tests ONLY — prod always takes the module table.
 * Lives HERE (not scorers-price.ts) so the registry's `derived.amber/red` chart bands and the scorer
 * read the SAME row — the one touch point per id (`src/registry.test.ts` lints the parity).
 */
export function rsCuts(id: string, overrides: Readonly<Record<string, RsCuts>> = RS_CUT_OVERRIDES): RsCuts {
  return { ...(Object.hasOwn(overrides, id) ? overrides[id]! : RS_SMH_DESCRIPTOR.scorer.constants) };
}

// Legacy names, DERIVED (never restated) — shared windows first, then F13/DB_* cuts:
export const MA_WINDOW = PRICE_WINDOWS.ma;
export const RET_WINDOW = PRICE_WINDOWS.ret;
export const HIGH_WINDOW = PRICE_WINDOWS.high;
export const HIGH_WINDOW_SHORT = PRICE_WINDOWS.highShort;
export const MA_SHORT = PRICE_WINDOWS.maShort;
export const HYGLQD_MA = F13_DESCRIPTOR.scorer.constants.maWindow;
export const HYGLQD_AMBER = F13_DESCRIPTOR.scorer.constants.amber;
export const HYGLQD_RED = F13_DESCRIPTOR.scorer.constants.red;
export const HYGLQD_RET_WINDOW = F13_DESCRIPTOR.scorer.constants.retWindow;
export const HYGLQD_D20_AMBER = F13_DESCRIPTOR.scorer.constants.d20Amber;
export const HYGLQD_D20_RED = F13_DESCRIPTOR.scorer.constants.d20Red;
export const DOWNSIDE_AMBER = DB_SMH_DESCRIPTOR.scorer.constants.amber;
export const DOWNSIDE_RED = DB_SMH_DESCRIPTOR.scorer.constants.red;
export const DOWNSIDE_XLK_AMBER = DB_XLK_DESCRIPTOR.scorer.constants.amber;
export const DOWNSIDE_XLK_RED = DB_XLK_DESCRIPTOR.scorer.constants.red;
export const RS_MA_WINDOW = RS_SMH_DESCRIPTOR.scorer.constants.maWindow;
export const RS_RED = RS_SMH_DESCRIPTOR.scorer.constants.red;
export const RS_XLK_AMBER = RS_XLK_DESCRIPTOR.scorer.constants.amber;
export const RS_XLK_RED = RS_XLK_DESCRIPTOR.scorer.constants.red;
export const RELSTR_MA_WINDOW = F6_DESCRIPTOR.scorer.constants.maWindow;
export const RELSTR_AMBER = F6_DESCRIPTOR.scorer.constants.amber;
export const RELSTR_RED = F6_DESCRIPTOR.scorer.constants.red;

// --- composite instances (FXH · GT · GB · DISP · R7) — scorers keep their signatures and read the
// DERIVED legacy names below. ---

/** FXH FX-haven — 20d WORST-OF haven-bid move across EURUSD=X/CHF=X/JPY=X, direction HIGH (edges `≥`).
 *  Constants below are the SINGLE source; never restate. Polarity derivation lives with `fxHavenMoveSeries`. */
export const FXH_DESCRIPTOR = {
  family: "composite",
  scorer: { ref: "scoreFxHaven", constants: { amber: 0.035, red: 0.06 } },
  // FXH's detail chart uses the builder escape hatch (`buildFxhChart`) — not expressible declaratively; `constants: {}` by design.
  chart: { builder: { ref: "buildFxhChart", constants: {} } },
} as const satisfies CompositeDescriptor;

/** GT global trend — ACWI close vs its own MA200 (`maSpread` decision), direction LOW, both edges
 *  inclusive. Constants are the SINGLE source; both POSITIVE (fires ABOVE MA200 — a leading proximity gauge). */
export const GT_DESCRIPTOR = {
  family: "composite",
  scorer: { ref: "scoreGlobalTrend", constants: { amber: 0.059, red: 0.026 } },
} as const satisfies CompositeDescriptor;

/** ESTR QUARTER change in rate POINTS (`derived` "change"; `window` is the same 60-TRADING-DAY
 *  quarter F9/F11 use, NOT VELOCITY_WINDOW — ECB meetings are 6 weeks apart, so a 20-day window spans at
 *  most ONE meeting and red could never fire; a quarter spans two). Negative cuts ⇒ fires LOW on a
 *  policy-rate CUT (eufin top5 N2 route A): amber = two consecutive standard cuts, red = a cycle running
 *  faster than 25 bp/meeting (the crisis-cut regime). SINGLE source of window + pair, [USER] 2026-09-24. */
export const ESTR_DESCRIPTOR = {
  family: "composite",
  scorer: { ref: "scoreDerived", constants: { amber: -0.5, red: -0.75, window: 60 } },
} as const satisfies CompositeDescriptor;

/** ECISS euro-area composite CISS (0–1): level + 20d rise, rising = danger (eufin top5 C2).
 *  SINGLE source of both pairs, [USER]-hand-set 2026-09-24. */
export const ECISS_DESCRIPTOR = {
  family: "fred-level-velocity",
  thresholds: { amberLevel: 0.2, redLevel: 0.4, amberVelocity: 0.15, redVelocity: 0.25 },
} as const satisfies FredFamilyDescriptor;

/** HICP Δ6m (pp), HIGH: AMBER above `amberLevel` (inflation not falling), RED above `redLevel` — display only;
 *  classify is strict, so a tie at a cut reads the calmer state. SINGLE source of the pair, [USER]-ruled 2026-10-03 (R5). */
export const HICP_DESCRIPTOR = {
  family: "fred-level-velocity",
  thresholds: { amberLevel: 0, redLevel: 1.0 },
} as const satisfies FredFamilyDescriptor;

/** EURGBP (GBP per EUR, ECB ref rate): worst-of 20d % move OR % vs MA50, both HIGH (rising = danger).
 *  SINGLE source of both pairs + the MA window, [USER]-ruled 2026-09-25 (eurgbp seat-10 Q4). */
export const EURGBP_DESCRIPTOR = {
  family: "composite",
  scorer: {
    ref: "scoreReturnOrMaSpread",
    constants: { retAmber: 0.03, retRed: 0.05, maWindow: PRICE_WINDOWS.maShort, maAmber: 0.03, maRed: 0.05 },
  },
} as const satisfies CompositeDescriptor;

/** Per-indicator MA leg for `returnOrMaSpreadReadingSeries` (the return leg rides `indicator.derived`). */
export interface ReturnOrMaConfig {
  readonly maWindow: number;
  readonly maAmber: number;
  readonly maRed: number;
}

export const RETURN_OR_MA_CONFIG_OF: Readonly<Record<string, ReturnOrMaConfig>> = {
  EURGBP: EURGBP_DESCRIPTOR.scorer.constants,
};

/** GB global breadth — fraction (0..1) above own MA200, direction LOW, STRICT `<` both edges.
 *  Constants below are the SINGLE source; never restate. */
export const GB_DESCRIPTOR = {
  family: "composite",
  scorer: { ref: "scoreGlobalBreadth", constants: { amber: 0.72, red: 0.58 } },
  // GB's detail chart uses the builder escape hatch (`buildGbChart`); constants stay descriptor-resident (`GB_AMBER`/`GB_RED`), `constants: {}` here.
  chart: { builder: { ref: "buildGbChart", constants: {} } },
} as const satisfies CompositeDescriptor;

/** The GB breadth constituents, FIXED ORDER — an input BASKET (run-cycle-feeds.ts, goldens/dispatch.ts, backfill.ts;
 *  mapped to `CMP_GB_*` by registry.ts). Module-level, not in the descriptor. `as const` is load-bearing. */
export const GB_SYMBOLS = ["SPY", "VGK", "EWJ", "VWO", "XLP", "XLV", "VYM"] as const;

/** HCX capex basket — 4 mega-cap buyers, equal-weighted + daily-rebalanced by `hcxBasketSeries`,
 *  scored ÷ SPY. Module-level `as const` (GB_SYMBOLS precedent); iterated by run-cycle/backfill/registry. */
export const HCX_SYMBOLS = ["GOOGL", "META", "MSFT", "AMZN"] as const;

/** DISP dispersion — 20d basket RETURN is the TRIGGER, correlation only CONFIRMS, DEPTH splits RED/AMBER.
 *  `corr` 0.75 STRICT `>`; deliberately NOT in `CALIB_MAP` (hand-typed). Firing rate: dashboard.composites.test.ts. */
export const DISP_DESCRIPTOR = {
  family: "composite",
  // corrP/corrPWindow/corrPMinObs size a ROLLING (never expanding — read path reproduces it) p90 pushing AMBER → RED.
  scorer: {
    ref: "scoreDispersion",
    constants: { corr: 0.75, basketRed: -0.025, corrP: 0.9, corrPWindow: 756, corrPMinObs: 252 },
  },
  // DISP's detail chart uses the builder escape hatch (`buildDispChart`); `constants: {}` by design.
  chart: { builder: { ref: "buildDispChart", constants: {} } },
} as const satisfies CompositeDescriptor;

/** R7 bull-steepener — severity on DYNAMIC cuts: Δ20(2y) & Δ20(steepening) ranked over a rolling
 *  `window`-day tail, so `amberP`/`redP` are TAIL PROBABILITIES; legs join `or`. Decomposed on 2y vs 10y, NOT T10Y3M. */
export const R7_DESCRIPTOR = {
  family: "composite",
  scorer: { ref: "scoreBullSteepener", constants: { amberP: 0.15, redP: 0.03, minObs: 126, window: 126 } },
} as const satisfies CompositeDescriptor;

/** VTP VIX backwardation PERSISTENCE — bands the consecutive backwardation STREAK, not the ratio level.
 *  CONTEXT (notify-excluded). ⚠ `backwardationRatio` MUST NOT be derived from `VT_DESCRIPTOR.red` (trap #3). */
export const VTP_DESCRIPTOR = {
  family: "composite",
  scorer: {
    ref: "scoreVixTermPersistence",
    constants: { backwardationRatio: 1.0, streakAmber: 5, streakRed: 10 },
  },
} as const satisfies CompositeDescriptor;

/** ECY excess-CAPE-yield × GT gate — scored scalar = expanding-percentile RANK of monthly ECY; rank ≤
 *  `expensiveP` = expensive, then GT grades AMBER/RED; cheap stays GREEN. `maxStaleDays` mirrors VAL_MAX_STALE_DAYS. */
export const ECY_DESCRIPTOR = {
  family: "composite",
  scorer: {
    ref: "scoreEcy",
    constants: { expensiveP: 0.02, minObs: 120, maxStaleDays: 60 },
  },
} as const satisfies CompositeDescriptor;

/** CQS EBP-bridge — Baa−Aaa quality-spread Δ from the EBP anchor, z-scored (composite + `BespokeRef`).
 *  `sigmaFloor` guards quiet-regime σ-collapse (below it z ⇒ GREEN). z cuts HAND-SET — the ONLY source. */
export const CQS_DESCRIPTOR = {
  family: "composite",
  scorer: {
    ref: "scoreCreditBridge",
    constants: { zAmber: 1.25, zRed: 2.0, sigmaWindow: 250, sigmaFloor: 0.02 },
  },
  // CQS builder escape hatch (`buildCqsChart` paints the bridge Δ); `constants: {}`.
  chart: { builder: { ref: "buildCqsChart", constants: {} } },
} as const satisfies CompositeDescriptor;

/** R6 MOVE bond implied-vol — TWO legs `combine: "or"`: VELOCITY z + the ABSOLUTE pair off `R6.thresholds`
 *  (ONE source). NO `levelBand`. ⛔ DO NOT RE-ADD A PERCENTILE LEVEL LEG. `"rolling-percentile"` KIND stays in the union. */
export const R6_DESCRIPTOR = {
  family: "composite",
  scorer: {
    ref: "scoreMoveLevel",
    constants: { velWindow: 5, velSigmaWindow: 250, measure: "log", zAmber: 1.5, zRed: 2.5 },
  },
  combine: "or",
  // R6 builder escape hatch (`buildMoveChart` draws both legs — absolute pair + velocity z); `constants: {}`.
  chart: { builder: { ref: "buildMoveChart", constants: {} } },
} as const satisfies CompositeDescriptor;

/** BONOS Spanish−German 10y spread (bp) — TWO legs `combine: "or"`: a VELOCITY z (worst-of z on Δbp velWindow /
 *  velSlowWindow between `endpointMean`-close means, over a velSigmaWindow σ of the same smoothed Δ) — the ONLY
 *  source — + the ABSOLUTE pair off `BONOS.thresholds`. Chart = `buildBtpChart`: the level pair + velocity z. */
export const BONOS_DESCRIPTOR = {
  family: "composite",
  scorer: {
    ref: "scoreBonosSpread",
    constants: { velWindow: 5, velSlowWindow: 20, velSigmaWindow: 750, measure: "bp", endpointMean: 2, zAmber: 1.5, zRed: 2.5 },
  },
  combine: "or",
  chart: { builder: { ref: "buildBtpChart", constants: {} } },
} as const satisfies CompositeDescriptor;

// Legacy names, DERIVED (never restated):
export const FXH_AMBER = FXH_DESCRIPTOR.scorer.constants.amber;
export const FXH_RED = FXH_DESCRIPTOR.scorer.constants.red;
export const GT_AMBER = GT_DESCRIPTOR.scorer.constants.amber;
export const GT_RED = GT_DESCRIPTOR.scorer.constants.red;
export const GB_AMBER = GB_DESCRIPTOR.scorer.constants.amber;
export const GB_RED = GB_DESCRIPTOR.scorer.constants.red;
export const DISP_CORR = DISP_DESCRIPTOR.scorer.constants.corr;
export const DISP_BASKET_RED = DISP_DESCRIPTOR.scorer.constants.basketRed;
export const DISP_CORR_P = DISP_DESCRIPTOR.scorer.constants.corrP;
export const DISP_CORR_P_WINDOW = DISP_DESCRIPTOR.scorer.constants.corrPWindow;
export const DISP_CORR_P_MIN_OBS = DISP_DESCRIPTOR.scorer.constants.corrPMinObs;
export const BULL_AMBER_P = R7_DESCRIPTOR.scorer.constants.amberP;
export const BULL_RED_P = R7_DESCRIPTOR.scorer.constants.redP;
export const BULL_MIN_OBS = R7_DESCRIPTOR.scorer.constants.minObs;
export const BULL_CUT_WINDOW = R7_DESCRIPTOR.scorer.constants.window;
export const VT_BACKWARDATION_RATIO = VTP_DESCRIPTOR.scorer.constants.backwardationRatio;
export const VT_STREAK_AMBER = VTP_DESCRIPTOR.scorer.constants.streakAmber;
export const VT_STREAK_RED = VTP_DESCRIPTOR.scorer.constants.streakRed;
export const ECY_EXPENSIVE_P = ECY_DESCRIPTOR.scorer.constants.expensiveP;
export const ECY_MIN_OBS = ECY_DESCRIPTOR.scorer.constants.minObs;
export const ECY_MAX_STALE_DAYS = ECY_DESCRIPTOR.scorer.constants.maxStaleDays;

/** PER-POINT (moving) band cuts — the ONE source for every id whose level band is a per-DATE SERIES.
 *  `p` = percentile of own expanding history, `key` = wire key. SINGLE SOURCE; never restate. Lives at END (TDZ). */
export const POINT_BAND_CUTS_OF: Record<
  string,
  ReadonlyArray<{ level: "amber" | "red"; key: string; p: number; minObs?: number; firesHighward?: boolean }>
> = {
  // F3 (NFCIRISK) — level pair of the synth cuts; velocity amber rides SECONDARY (F3_VELOCITY_BAND).
  F3: [
    { level: "amber", key: "levelAmber", p: SYNTH_AMBER_PCTILE },
    { level: "red", key: "levelRed", p: SYNTH_RED_PCTILE },
  ],
  CG: [
    { level: "amber", key: "levelAmber", p: CG_DESCRIPTOR.levelBand.amberP },
    { level: "red", key: "levelRed", p: CG_DESCRIPTOR.levelBand.redP },
  ],
  // ⛔ No R6 row — its percentile leg is deleted; R6's level cut is its registry `thresholds` scalar
  // (buildMoveChart draws it).
  ECY: [{ level: "amber", key: "ecyAmber", p: ECY_EXPENSIVE_P }],
  // F5/SPCONC breadth — SCORED dynamic band, HIGH-firing; pair reads off each id's own config.
  // `minObs` absent BY DESIGN (rolling → `api/series.ts` routes through `breadthCutSeries`, which carries the window).
  F5: [
    { level: "amber", key: "breadthAmber", p: BREADTH_AMBER_P, firesHighward: true },
    { level: "red", key: "breadthRed", p: BREADTH_RED_P, firesHighward: true },
  ],
  SPCONC: [
    { level: "amber", key: "breadthAmber", p: SPCONC_BAND.amberP, firesHighward: true },
    { level: "red", key: "breadthRed", p: SPCONC_BAND.redP, firesHighward: true },
  ],
  // HCX — LOW twin (mirrored low-tail); pair off HCX_BAND, `firesHighward` false → `<p` side.
  HCX: [
    { level: "amber", key: "breadthAmber", p: HCX_BAND.amberP },
    { level: "red", key: "breadthRed", p: HCX_BAND.redP },
  ],
};

/** id → composite-family scored LEVEL band — sibling of the ratio-spread bands so the detrend
 *  back-transform reaches a composite level leg with no id branch. EMPTY today; kept as the seam. */
export const COMPOSITE_LEVEL_BAND_OF: Readonly<
  Record<string, NonNullable<RatioSpreadDescriptor["levelBand"]>>
> = {};

/** id → the composite VELOCITY leg's z constants (ids drawing that z on the secondary axis, `velZ`).
 *  Values are the descriptors' own `scorer.constants` — scorer-vintage hashes this table as their only vintage cover.
 *  `velSlowWindow` present (BONOS) ⇒ a second horizon: the chart draws the worst-of the two z. */
export const VELOCITY_Z_CONSTANTS_OF: Readonly<
  Record<
    string,
    { velWindow: number; velSlowWindow?: number; velSigmaWindow: number; measure: VelocityMeasure; endpointMean?: number; zAmber: number; zRed: number }
  >
> = {
  BONOS: BONOS_DESCRIPTOR.scorer.constants,
  R6: R6_DESCRIPTOR.scorer.constants,
};

/** THE detail-chart window config — ONE span in both units (`DETAIL_WINDOW` trading · `DETAIL_WINDOW_DAYS`
 *  calendar). Also the BACKFILL floor (`scripts/probe-leg-span.ts`). */
const DETAIL_WINDOW_CONFIG = {
  /** Hand-set: ~2 years of closes. The SINGLE source — nothing may restate it or its calendar-day form. */
  span: 510,
} as const;

/** Default detail-chart visible window (TRADING days) — `api/series.ts` DEFAULT_LIMIT imports it;
 *  `public/chart-primitives.js` DETAIL_LIMIT is pinned equal by test. */
export const DETAIL_WINDOW = DETAIL_WINDOW_CONFIG.span;

/** Same span in CALENDAR days — `api/indicators.ts` stamps it as `ChartSpec.fromDays` on date-anchored ids. */
export const DETAIL_WINDOW_DAYS = tradingToCalendarDays(DETAIL_WINDOW_CONFIG.span);

/** Per-id chart/read-path declaration consumed by `api/series.ts` (branch dispatch, series ids,
 *  per-point cut rows) and `chart-rail.ts` (`ChartSpec.renderer`, visible window). */
export interface ChartDescriptor {
  branch?: "fxHaven" | "bullSteepener" | "dispersion" | "ecyJoin";
  /** Input ids the branch re-reads at read time (FXH/R7 FRED series; ECY the F7 store id + DFII10). */
  seriesIds?: readonly string[];
  bandCuts?: ReadonlyArray<{ level: "amber" | "red"; key: string; p: number; minObs?: number; firesHighward?: boolean }>;
  /** Additive per-date cut OVERLAY (`withPostInversionCut` shape): re-fetches the id's feeds. A bridge
   *  cut is a σ multiple the stored Δ can't reconstruct, so it needs the feed re-read. */
  cutOverlay?: "creditBridge";
  renderer?: "single" | "fx" | "derived";
  window?: number;
}

/** `bandCuts` rows are REFERENCES into `POINT_BAND_CUTS_OF` (single source), never restated;
 *  a declared `renderer` must equal the FE shape-sniff — pinned in `chart-rail.test.ts`. */
export const CHART_DESCRIPTOR_OF: Readonly<Record<string, ChartDescriptor>> = {
  FXH: {
    branch: "fxHaven",
    seriesIds: ["CMP_FXH_DEXUSEU", "CMP_FXH_DEXSZUS", "CMP_FXH_DEXJPUS"],
    renderer: "fx",
  },
  R7: { branch: "bullSteepener", seriesIds: ["T10Y3M", "DGS2", "DGS10"], renderer: "single" },
  DISP: { branch: "dispersion", renderer: "derived" },
  CG: { bandCuts: POINT_BAND_CUTS_OF.CG },
  // ⛔ No R6 `bandCuts` row (percentile leg deleted). ⚠ `supportsRecompute` (api/series.ts) must
  // STILL exclude it (bespoke two-leg scorer ≠ generic recompute); that exclusion hangs off `COMPOSITE_RESTATE_OF`.
  // ECY: `branch: "ecyJoin"` re-joins F7 (store) × DFII10 (FRED) and draws `ecyExpensiveCutSeries`; `bandCuts` names the wire key + label `p`.
  ECY: { branch: "ecyJoin", seriesIds: ["F7", "DFII10"], bandCuts: POINT_BAND_CUTS_OF.ECY },
  F5: { bandCuts: POINT_BAND_CUTS_OF.F5 },
  SPCONC: { bandCuts: POINT_BAND_CUTS_OF.SPCONC },
  HCX: { bandCuts: POINT_BAND_CUTS_OF.HCX },
  // CQS rides the ADDITIVE bridge-cut overlay (σ multiple in Δ units, re-derived at read time), not `bandCuts`.
  CQS: { cutOverlay: "creditBridge" },
};

/** Post-inversion floor-cut wire key+level — `api/series.ts` emits off `postInversionCutSeries`, chart spec reads via `fromPoint`. */
export const POST_INVERSION_BAND = { level: "amber", key: "postInvAmber" } as const;

/** Always-on drawdown CUT wire key+level (un-wired from R1 since 2026-08-31) — `api/series.ts` emits
 *  off `drawdownCutSeries`, a SECOND amber line beside the post-inversion floor. */
export const R1_DRAWDOWN_BAND = { level: "amber", key: "drawdownAmber" } as const;

/** R8 mean-space cut pair wire keys+levels — `api/series.ts` emits off `meanLevelCutSeries`, `buildR8Chart` reads via `fromPoint`. */
export const R8_MEAN_CUT_BANDS = [
  { level: "amber", key: "r8CutAmber" },
  { level: "red", key: "r8CutRed" },
] as const;

/** F3 (NFCIRISK) velocity-amber wire key+level — synth velocity expanding percentile; `buildF3Chart` reads it on axis 2. No red twin. */
export const F3_VELOCITY_BAND = { level: "amber", key: "velAmber" } as const;

/** CQS EBP-bridge moving cut wire keys+levels — `api/series.ts` emits off `creditBridgeCutSeries`.
 *  ⚠ σ MULTIPLE never stated here; `from` names the `CQS_DESCRIPTOR.scorer.constants` field. Wire units are Δ, not σ. */
export const CQS_CUT_BANDS = [
  { level: "amber", key: "cqsAmber", from: "zAmber" },
  { level: "red", key: "cqsRed", from: "zRed" },
] as const satisfies ReadonlyArray<{
  level: "amber" | "red";
  key: string;
  from: keyof typeof CQS_DESCRIPTOR.scorer.constants;
}>;

/** R7 bull-steepener moving cut wire keys+levels — `api/series.ts` emits off `bullSteepenerLegSeries`,
 *  `buildR7Chart` reads via `fromPoint`. Probabilities live on `R7_DESCRIPTOR`. */
export const R7_CUT_BANDS = [
  { level: "amber", key: "r7DropAmber" },
  { level: "red", key: "r7DropRed" },
  { level: "amber", key: "r7SteepAmber" },
  { level: "red", key: "r7SteepRed" },
] as const;

/** id → declarative chart params (chart rail dispatch, `buildFamilyChart`). Values are REFERENCES to the
 *  descriptors' own `chart` fields — never restated. Lives at END (TDZ, dereferences them at eval). */
export const CHART_PARAMS_OF: Readonly<Record<string, FamilyChartParams>> = {
  // ⛔ Do NOT reinstate a per-id WINDOW row to make one id deeper — raise `DETAIL_WINDOW_CONFIG.span`.
  GB: GB_DESCRIPTOR.chart,
  // CQS — builder escape hatch (`buildCqsChart` paints the bridge Δ; z cuts moving, deferred).
  CQS: CQS_DESCRIPTOR.chart,
  // BONOS — builder escape hatch through the id-generic `buildBtpChart` (its own `VELOCITY_Z_CONSTANTS_OF` row + level pair).
  BONOS: BONOS_DESCRIPTOR.chart,
  // BUND — builder escape hatch (`buildCurveChart`: slope level + the two-sided Δ20 velocity pair on axis 2).
  BUND: BUND_DESCRIPTOR.chart,
  // R6 — builder escape hatch (`buildMoveChart` draws every scored leg).
  R6: R6_DESCRIPTOR.chart,
  // ECY — amber-only expensive cut (RED needs GT trend broken); MOVING line off `ECY_EXPENSIVE_P` (`POINT_BAND_CUTS_OF.ECY`).
  ECY: {
    displayBands: [
      {
        level: "amber",
        valueFrom: "perPoint",
        label: `amber ≤p${+(ECY_EXPENSIVE_P * 100).toFixed(1)} of own history (red only if GT trend breaks)`,
      },
    ],
  },
  // R4 — storedDelta dual-axis (DFII10 level beside the scored Δ20d); velocity-only ⇒ no primary bands.
  R4: { dualAxis: { unit: "pp", compute: "storedDelta" } },
  // R2 — same shape as R4 (DGS10 level beside the scored Δ20d) — user ask 2026-10-14: the detail showed only the Δ.
  R2: { dualAxis: { unit: "pp", compute: "storedDelta" } },
  // F1 — dual-axis params are EXPOSURE-sourced (can't value-import here), so builder escape hatch `buildF1Chart`.
  F1: { builder: { ref: "buildF1Chart", constants: {} } },
  // R8 — builder escape hatch (second axis is a probability transform of the level, no bands).
  R8: { builder: { ref: "buildR8Chart", constants: {} } },
  // R7 — bespoke `buildR7Chart`: T10Y3M primary, both Δ20 legs + four moving ranked cuts on axis 2.
  R7: { builder: { ref: "buildR7Chart", constants: {} } },
  // F2 — dual-axis storedDelta variant so its registry velocity pair (scored invisibly) gets a line.
  F2: { dualAxis: { unit: "pp", compute: "storedDelta" } },
  // F3 (NFCIRISK) — builder `buildF3Chart`: stored-delta shape but MOVING synth cuts (perPoint lines); no velocity RED.
  F3: { builder: { ref: "buildF3Chart", constants: {} } },
  // CCC — dual-axis storedDelta so its Δ20 pair (pp) gets a line beside the level bands.
  CCC: { dualAxis: { unit: "pp", compute: "storedDelta" } },
  // ⚠ F9 (since 2026-08-07) and F11 (2026-08-08) have NO entry here — level axes retired, now single velocity axis.
  // Re-adding a `dualAxis` row would draw a LEVEL band pair with no cut behind it. F11's grid lives on the REGISTRY entry.
  // T10YIE/T5YIFR — dual-axis storedDelta (velocity pair added with the row, never scored invisibly); no `legBands`.
  // Unit "pp" on every dual-axis level-Δ of a %-quoted id (R4/F2/T10YIE/T5YIFR, F1 in `buildF1Chart`): a level
  // difference is percentage POINTS — a "%" suffix read as a relative change (user 2026-10-10); "%" is for a relative speed leg.
  T10YIE: { dualAxis: { unit: "pp", compute: "storedDelta" } },
  T5YIFR: { dualAxis: { unit: "pp", compute: "storedDelta" } },
  // ECISS — dual-axis storedDelta so its velocity pair gets a line beside the level bands.
  ECISS: { dualAxis: { unit: "", compute: "storedDelta" } },
  // last bespoke refs + the declarative F7 context entry:
  FXH: FXH_DESCRIPTOR.chart,
  DISP: DISP_DESCRIPTOR.chart,
  // F7 — HIGH-firing expanding-percentile bands over CAPE's stored history (p80 amber / p95 red), display-only, F7 unscored.
  // price-accel — builder escape hatch `buildPriceAccelChart` (constants in slow.ts, can't value-import here).
  "price-accel": { builder: { ref: "buildPriceAccelChart", constants: {} } },
  // complacency-vix/high — builder escape hatch; each leg BINARY, draws one AMBER line (vixPctile vs VIX_LOW_PCTILE; distFraction vs NEAR_HIGH_FRAC).
  "complacency-vix": { builder: { ref: "buildComplacencyVixChart", constants: {} } },
  "complacency-high": { builder: { ref: "buildComplacencyHighChart", constants: {} } },
  F7: {
    displayBands: [
      { level: "amber", valueFrom: "capePct", p: 0.8 },
      { level: "red", valueFrom: "capePct", p: 0.95 },
    ],
  },
};
