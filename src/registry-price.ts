/**
 * Registry — price-scorer family (registry split, 2026-08-15): the bespoke price-fed ids
 * (F4/F5/SPCONC/F6/F8/F13/NVDA), the downside-break detectors, the PRICE_SCORERS table,
 * and the raw track rows (SLOW/PENSION/BOTTOM) + their display-only id sets.
 * Import surface: this file — edit and import here.
 */

import { type DerivedView, type Indicator, type Observation, type Reading } from "./domain-types.js";
import {
  // Stage 2b.1: cuts live on F4_/F6_/F8_DESCRIPTOR.
  F4_AMBER_RET,
  F4_RED_RET,
  RELSTR_MA_WINDOW,
  RELSTR_AMBER,
  RELSTR_RED,
  MU_AMBER,
  MU_RED,
  // Stage 2b.2: shared windows live on PRICE_WINDOWS, F13's cuts on F13_DESCRIPTOR.
  MA_WINDOW,
  RET_WINDOW,
  HIGH_WINDOW,
  HYGLQD_MA,
  HYGLQD_AMBER,
  HYGLQD_RED,
  RS_MA_WINDOW,
  rsCuts,
  GT_AMBER,
  GT_RED,
  EXSH_GATE_DESCRIPTOR,
} from "./family-descriptor-rows.js";

/** The RS chart-band pair for `id`, read off the scorer's OWN parameter row (`rsCuts`) — the registry
 *  never restates a cut: KBE_RS (and a since-retired EXSH rel-strength row) drew the generic 0/−3% bands while scoring at their hand-set
 *  rows until this seam (2026-09-24). `src/registry.test.ts` lints every routed id. */
const rsBands = (id: string): Pick<DerivedView, "amber" | "red"> => {
  const { amber, red } = rsCuts(id);
  return { amber, red };
};
import { withMultipliedThresholds } from "./registry-fred.js";
import { AT1_BACKFILL_YEARS, EUFIN_BACKFILL_YEARS, EXSH_GATE_BACKFILL_YEARS, SEMIS_BACKFILL_YEARS } from "./backfill-depth.js";
import {
  scoreSemis,
  semisReadingSeries,
  breadthReadingSeries,
  breadthBandRanked,
  BREADTH_MIN_CLOSES,
  scoreRelStrengthBreak,
  relStrengthBreakReadingSeries,
  scoreCreditAppetite,
  creditAppetiteReadingSeries,
  scoreMemGate,
  memGateReadingSeries,
  nvdaGateReadingSeries,
  globalTrendReadingSeries,
  exshGateReadingSeries,
} from "./scorers-price.js";
import { withNewest } from "./scorers-core.js";

export const F4: Indicator = withMultipliedThresholds({
  id: "F4",
  label: "SMH",
  longLabel: "Semis momentum (SMH)",
  series: "SMH", // primary symbol; NVDA is a second input to the scorer
  // CONTEXT (Phase-2 C5, 2026-06-28): a −15/−25%-below-MA200 semis drawdown is
  // COINCIDENT, not leading, so F4 is surfaced for awareness but excluded from
  // FIN_score (joins F5). The harness showed no leading-deceleration leg to
  // split out, so F4 is demoted whole rather than split.
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreSemis), not classify()
  unit: "",
  // 6-mo trailing return; bands are necessary-not-sufficient (compound MA200 gate
  // is surfaced via the F4 annotation in detailChart, not drawable as a line).
  derived: {
    kind: "return",
    window: RET_WINDOW,
    amber: F4_AMBER_RET,
    red: F4_RED_RET,
    label: "6-mo return",
    unit: "%",
  },
});

export const F5: Indicator = withMultipliedThresholds({
  id: "F5",
  label: "QQQ/QQQE",
  longLabel: "Breadth (QQQ/QQQE)",
  series: "QQQ", // ratio numerator; QQQE is the denominator input
  channel: "CONTEXT", // excluded from the roll-up — context only
  thresholds: {}, // bespoke scorer (scoreBreadth)
  unit: "",
  // % distance of the QQQ/QQQE RATIO from ITS rolling 12-mo high — NOT a price
  // drawdown. NO static band here: the cut is dynamic and per-point (rolling-percentile
  // on the strict-prior dist, scoreBreadth); the drawn band arrives via Stage 2b bandCuts.
  // The axis label names the ratio because "% from 12-mo high" alone reads as XLK/QQQ
  // drawdown and inverts the signal's meaning (2026-07-23; direction measured + inversion
  // falsified, D5).
  derived: {
    kind: "highDist",
    window: HIGH_WINDOW,
    amber: null,
    red: null,
    label: "QQQ/QQQE % from 12-mo high",
    unit: "%",
  },
});

// --- SPCONC S&P 500 concentration (SPY/RSP) — BROAD-market twin of F5 -----------
//
// SP500IT coverage rung 2 (2026-07-23, D5′-a/-b′). F5 reads concentration inside the
// Nasdaq-100 (tech-LED); SPCONC reads it across the whole S&P 500 — cap-weighted SPY
// vs its equal-weighted twin RSP. Mirrors F5 EXACTLY: the same guard-light
// `breadthReadingSeries` row (generic in its two inputs; only its parameter NAMES say qqq/qqqe), CONTEXT
// channel, `trend` family, full rolling-percentile band (breadthReadingSeries fires HIGH-ward off
// the `BREADTH_*` triple — never restated here — the dynamic dial-driving break, 2026-08-20).
//
// provenance: docs/indicator-cut-provenance.md §SPCONC (the at-high vs 20d-ROC measurement).
export const SPCONC: Indicator = withMultipliedThresholds({
  id: "SPCONC",
  label: "SPY/RSP",
  longLabel: "Concentration (SPY/RSP)",
  series: "SPY", // ratio numerator; RSP is the denominator input
  channel: "CONTEXT", // excluded from the roll-up — context only
  thresholds: {}, // bespoke scorer (scoreBreadth)
  unit: "",
  // % distance of the SPY/RSP RATIO from ITS rolling 12-mo high — NOT a price drawdown.
  // NO static band here: the cut is dynamic and per-point (rolling-percentile on the
  // strict-prior dist, scoreBreadth); the drawn band arrives via Stage 2b bandCuts. The
  // axis label leads with the ratio for the same reason F5's does: a bare "% from 12-mo
  // high" reads as an index drawdown and inverts the card's meaning.
  derived: {
    kind: "highDist",
    window: HIGH_WINDOW,
    amber: null,
    red: null,
    label: "SPY/RSP % from 12-mo high",
    unit: "%",
  },
});

// --- F6 SMH/SPY — MA200 trend gate (E4, [USER] 2026-09-02) ---------------------
// RED iff the SMH/SPY ratio closes below its own MA200 (no AMBER leg); channel CONTEXT (excluded
// from every roll-up; the danger engine reads it off globalFamilies → Semis / S&P IT legs only,
// `MEMBER_WEIGHT.F6`). Same scorer + `derived` transform as RS_SMH at `PRICE_WINDOWS.ma`.
export const F6: Indicator = withMultipliedThresholds({
  id: "F6",
  label: "SMH/SPY",
  longLabel: "Semis rel-strength - SMH/SPY vs MA200",
  series: "SMH", // ratio numerator; SPY is the 2nd scorer input (denominator)
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread", // % vs MA200 of the SMH/SPY ratio — the scorer's own spread transform
    window: RELSTR_MA_WINDOW,
    amber: RELSTR_AMBER,
    red: RELSTR_RED,
    label: "SMH/SPY % vs MA200",
    unit: "%",
  },
});

// --- F8 Micron memory-cycle (MU) — soft confirming member ---------------------
//
// The best keyless daily proxy for the DRAM/NAND memory cycle (a pure-play memory
// maker's price tracks the memory supply/price cycle). Noisier than a true spot feed
// (equity beta + single-name idiosyncrasy), so it ships SOFT/low-weight — a confirming
// nudge on the Semis leg, never a solo trigger (weight 0.6 → AMBER-only). channel
// CONTEXT (notify-neutral; danger-engine only). Bespoke single-input compound gate
// scoreMemGate (ret6 ≤ band AND MU < MA200·MU_MA_MULT), NOT classify(). Bands are STARTING
// PRIORS — WIDER than F4 to cut single-name noise; F6/F8 calibration deferred, ship with
// priors. `derived` line = the 6-mo return (one of the two gate conditions; the compound
// AND-gate isn't a single drawable line — surfaced via the state ribbon, like F4/NVDA).
export const F8: Indicator = withMultipliedThresholds({
  id: "F8",
  label: "MU",
  longLabel: "Micron memory-cycle (MU)",
  series: "MU",
  backfill: { years: SEMIS_BACKFILL_YEARS }, // Semis top-10 seat
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreMemGate), not classify()
  unit: "",
  derived: {
    kind: "return",
    window: RET_WINDOW,
    amber: MU_AMBER,
    red: MU_RED,
    label: "6-mo return",
    unit: "%",
  },
});

// --- F13 HYG/LQD credit appetite — leading, rate-clean credit member -----------
//
// The faster-reacting credit member: the HYG÷LQD ratio's %-spread vs its own MA50.
// HYG (high-yield ETF) / LQD (investment-grade ETF) nets out the shared rates/duration
// move, isolating credit-risk appetite. The lead is MEASURED, not a prior.
// provenance: docs/indicator-cut-provenance.md §F13
// channel CONTEXT,
// but NOT notify-neutral post-O2: the member state flows via GLOBAL_FAMILIES →
// computeFamilyPanel → the T1 dial's credit family (a Red CAN move the dial and fire a
// push) + the Value + cyclical/credit leg RAG. Bespoke dual-input scorer
// scoreCreditAppetite (HYG numerator, LQD the 2nd input), NOT classify(). Bands are
// STARTING PRIORS — uncalibrated (CALIB_MAP deferred, Phase-2 discipline). The `derived`
// line = the ratio's %-spread vs MA50 (kind "maSpread", single-sourced via decisionAt);
// LOW-is-bad, mirror of F4/F6's bands. ⚠ Since the 2026-08-08 two-leg ruling this is the
// scorer's SECOND leg only — the PRIMARY d20 velocity leg has no `derived` slot (one per
// indicator). So `derived` no longer reproduces the scored state on its own; the scorer is
// the authority. Both legs ARE drawn since 2026-08-29: `SECOND_LEG_CHART_OF`
// (family-descriptor-rows.ts) adds d20 to the derived route as a client-computed `trailingReturn`
// over the plotted ratio, with its own cut pair — so "the ms50 line is under its red cut but the
// card is AMBER" now reads off the picture (RED is the AND). ⚠ d20 takes the PRIMARY axis and the
// HYG/LQD ratio line is NOT drawn: the ratio is unscored and carries no cut, while the two legs
// need two ranges (d20 swings several times wider than ms50) to stop overlapping.
export const F13: Indicator = withMultipliedThresholds({
  id: "F13",
  backfill: { years: EUFIN_BACKFILL_YEARS }, // EU-Fin top-8 seat
  label: "HYG/LQD",
  longLabel: "Credit appetite (HYG/LQD)",
  series: "HYG", // HY proxy / ratio numerator; LQD is the 2nd scorer input (denominator)
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreCreditAppetite), not classify()
  unit: "",
  derived: {
    kind: "maSpread", // % vs MA50 (LOW-is-bad); the scorer's s = ratio/MA50 − 1 is this same transform
    window: HYGLQD_MA,
    amber: HYGLQD_AMBER,
    red: HYGLQD_RED,
    label: "HYG/LQD vs MA50",
    unit: "%",
  },
});

// F12 (China credit impulse) was DELETED here 2026-07-17 — do not re-add it.
// provenance: docs/indicator-cut-provenance.md §F12

/** Price indicators — scored via the bespoke fns below, NOT the FRED fetch loop. */
export const PRICE_INDICATORS: Indicator[] = [F4, F5, F6, F8, F13];

// NVDA standalone CONTEXT indicator (2026-06-28). NVDA's close-vs-its-own-MA200 is
// already the Red-gate input to F4 (scoreSemis only trips Red when NVDA < its MA200);
// here it is surfaced as a first-class indicator so that gate is visible day-by-day
// via the detail chart's state ribbon. CONTEXT → excluded from every roll-up
// (the retired verdict engine never reads CONTEXT), so it can never move the alert level. Scored
// by the bespoke scoreNvdaGate (scorers-price.ts), NOT classify(); deliberately kept OUT of
// PRICE_INDICATORS (it isn't fetched/scored via that list's price loop) and added to
// ALL_INDICATORS explicitly.
export const NVDA: Indicator = withMultipliedThresholds({
  id: "NVDA",
  label: "NVDA",
  longLabel: "Nvidia (NVDA)",
  series: "NVDA",
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreNvdaGate), not classify()
  unit: "",
  // % distance from MA200; band at 0 = price crossing below its MA200 (Amber).
  derived: {
    kind: "maSpread",
    window: MA_WINDOW,
    amber: 0,
    red: null,
    label: "% vs MA200",
    unit: "%",
  },
});

/**
 * Never-scored VALUE-ONLY ids: they carry a live `value` for display but a PLACEHOLDER
 * `state:"GREEN"` that NO scorer produced and that must not be read as a real calm signal.
 * `priceLegReadingSeries` (src/pension.ts) stamps `rawState=state="GREEN"` for every `PENSION_INDICATORS` leg,
 * the 2 VIX bottom legs are built by the SAME helper (src/tracks.ts), and F7 is a display-only
 * CONTEXT card (`thresholds: {}` AND no bespoke scorer — unlike VTP/G1/BRENT, whose empty
 * `thresholds` only means "not classify()", so those ARE scored and are NOT listed here).
 *
 * Lives in the registry because it is now read on BOTH sides of the api/src line — hoisted here
 * 2026-08-05 from api/status.ts (which re-exports it, so its consumers are unchanged):
 *  • /api/status + /api/series — the served DTO is marked `valueOnly`, so the FE shows the value but
 *    suppresses the RAG dot and strokes the detail ribbon neutral (public/app.js, detail-chart.js).
 *  • `verdictHoldLegs` (src/alert-band.ts) — an unscored card contributes nothing to any band, so its age
 *    must not arm the lag BAND-HOLD floor. See that function's docblock.
 * ⚠ NOT a universal filter: `api/lab.ts` passes its RECONSTRUCTED served readings to `coverageArmed`
 * WITHOUT this exclusion, so /lab and the cron already fold different peer populations.
 * F7 never reaches the /status loop (its reading rides a distinct `run_at` and is appended read-time
 * with `valueOnly` set explicitly); it is listed for the /api/series flag and the detail reader
 * special-cases it (a one-sided z-severity ribbon keyed on `meta.id === "F7"`).
 * DB_SMH is EXCLUDED: it is genuinely scored (via DOWNSIDE_DETECTORS on the cron path), so its dot is real.
 *
 * ⚠ For comparator ids (`VWO`/`VGK`/`XDEV`), `KBE` and the value-ladder inputs (`HYNIX`/`AMAT`/`KRW`/`COPPER`)
 * the `valueOnly` display flag is the whole live effect: the `verdictHoldLegs` exclusion is LATENT for these, since the
 * pension/comparator legs never become `Reading`s on the run path (`readings`, run-cycle-dial.ts, is
 * FRED + `PRICE_SCORERS` + CQS + confirmers; track legs ride `StoredReading[]` to
 * persistence only). It binds only if a pension leg ever joins `readings` — ruled `[USER]` acceptable.
 */
export const PLACEHOLDER_STATE_IDS: ReadonlySet<string> = new Set([
  "F7",
  "SPY",
  "DEXUSEU",
  "SP500IT",
  "LEGP_EUFIN",
  "LEGP_HEALTH",
  "LEGP_COMMOD",
  "LEGP_RAFI",
  "LEGP_SEMIS",
  "LEGP_SPIT",
  "LEGP_EM",
  "LEGP_SPX",
  "LEGP_EXUS",
  "LEGP_STAPLES",
  "VIX",
  "VIX3M",
  "VWO",
  "VGK",
  "XDEV",
  "KBE",
  "HYNIX",
  "AMAT",
  "KRW",
  "COPPER",
  "BBB",
]);

// --- Downside-break detectors (slice 2, design 2026-07-13) ------------------
//
// The per-leg drawdown-from-recent-high + MA50 trend-gate detector (scoreDownsideBreak
// / downsideBreakReadingSeries, scorers-price.ts) over the SMH semis proxy.
// It reuses the SMH daily closes ALREADY fetched for scoreSemis (run-dbfirst.ts) — zero new feed.
// Persisted as a GLOBAL-channel row under a DEDICATED reading id (DB_SMH) so it never
// collides with any other reading in the same atomic run; api/lab.ts maps DB_SMH → the
// display id ("SMH") for the /lab `downsideDetectors` strip. `channel:"GLOBAL"` (off every
// FIN/RATE roll-up; read by the dial/families — and the dial IS the notify band)
// → NOT in INDICATORS/PRICE_SCORERS/FAST_CONFIRMERS/TRACKS. NO `derived`.
// DB_SMH's SOLE role (post fast-breaks EARLY-WARN redesign D-D, 2026-07-21): it feeds the
// WATCH-capped `ew` escalator floor (EARLY_WARN_MEMBERS in t1dial.ts → `ewFloor`, alert-band.ts).
// It is in NO family — removed from the trend family (families.ts) and off the tech-confirmer slot
// — and no longer renders on any /lab board tile (its cell is the BAND `ew` row). `channel` stays
// GLOBAL — it is not part of the reading's storage key (toStoredReadings keys by id), and GLOBAL
// is already the convention for GLOBAL-channel rows off the FIN roll-up.
export const DB_SMH: Indicator = withMultipliedThresholds({
  id: "DB_SMH",
  label: "SMH break",
  longLabel: "Downside break - SMH",
  series: "SMH",
  channel: "GLOBAL",
  thresholds: {}, // bespoke drawdown+MA50 scorer (scoreDownsideBreak), not classify()
  unit: "",
});

// DB_XLK (SP500IT coverage rung 1, 2026-07-23) — the SAME detector shape on XLK, the
// S&P 500 IT sector proxy. The pension track is 100% SP500IT, so this is the DIRECT
// downside read on the thing actually held; every other tech-risk leg is a proxy for it.
// Mirrors DB_SMH's SHAPE — same `scoreDownsideBreak` composite, same MA50 gate + 63d high,
// same GLOBAL channel, same `thresholds: {}` — but carries its OWN cut pair
// (`DOWNSIDE_XLK_*`, derived off DB_XLK_DESCRIPTOR in
// family-descriptor-rows.ts, applied via `downsideCuts` in scorers-price.ts). The constants are separate
// from DB_SMH's so either pair can move alone. Its ONLY
// role is the WATCH-capped `ew` escalator floor (EARLY_WARN_MEMBERS, t1dial.ts) — NO family
// membership, NO `MEMBER_WEIGHT` row, NO `CALIB_MAP` entry, so it can never lead a rotation
// or drive WARNING/CRITICAL. Bands are STATED PRIORS — uncalibrated.
// The XLK fetch is duplicated with the `tracks.ts` pension display leg (stored as `SP500IT`)
// deliberately: sharing it means plumbing, not a rename.
export const DB_XLK: Indicator = withMultipliedThresholds({
  id: "DB_XLK",
  label: "XLK break",
  longLabel: "Downside break - XLK (S&P 500 IT)",
  series: "XLK",
  channel: "GLOBAL",
  thresholds: {}, // bespoke drawdown+MA50 scorer (scoreDownsideBreak), not classify()
  unit: "",
});

/**
 * The downside-break detectors as a single table both producers consume: run-dbfirst.ts
 * iterates it to score+persist (fetch `symbol`'s closes → downsideBreakReadingSeries
 * over `indicator`), and api/lab.ts iterates it to map the persisted `indicator.id`
 * (DB_SMH/DB_XLK) back to the eyeball-visible `id` ("SMH"/"XLK"). `as const` pins `id`
 * to the literal union `api/lab.ts` derives inline for `LabResponse.downsideDetectors`
 * (`(typeof DOWNSIDE_DETECTORS)[number]["id"]` — it self-widens). ⚠ Adding a row ALSO
 * requires widening the HAND-MAINTAINED `LabResponse.downsideDetectors` union in
 * `families.ts` and the `openapi.yaml` enum; the former fails the typecheck loudly at
 * api/lab.ts's assignment. `symbol` also drives the run-dbfirst.ts price fetch set.
 */
export const DOWNSIDE_DETECTORS = [
  { id: "SMH", indicator: DB_SMH, symbol: "SMH" },
  { id: "XLK", indicator: DB_XLK, symbol: "XLK" },
] as const;

/**
 * Single source of truth for the downside-detector READING/persisted id set
 * (`DB_SMH`/`DB_XLK` — the `.indicator.id` axis, NOT the eyeball `id` "SMH"/"XLK").
 * Every scattered `["DB_SMH","DB_XLK"]` literal that meant "the set of downside
 * detectors that exist" derives from this: the api DISPLAY sites (`api/indicators.ts`,
 * `api/series.ts`), the offline probe replay (`scripts/probe-earlywarn.ts`). Adding/removing a detector is then a
 * one-edit change to the `DOWNSIDE_DETECTORS` row above plus one golden-pin bump.
 * ORDER mirrors `DOWNSIDE_DETECTORS` (SMH→XLK) and `src/registry.test.ts` pins it. The ONE
 * order-sensitive consumer is `buildLabBand` (`alert-band.ts`, via `api/lab.ts`), which emits one ew
 * ROW per member in this order — **display only**; the notify-path floor is the bare order-blind OR
 * (`earlyWarnFires` → `ewFloor`), and the four display/script sites route through
 * `Set.has`/commutative reductions.
 * ⚠ SINCE THE B-1 RULING MEMBERSHIP here IS the notify
 * roster: `EARLY_WARN_MEMBERS` (`t1dial.ts`) IS this array, and `ew` is an any-one-fires WATCH gate
 * with no N-of-M — so a row added to `DOWNSIDE_DETECTORS` joins the notify path immediately. It reds
 * `t1dial.test.ts`'s membership pin first; that friction is the feature, not an obstacle to bump past.
 */
export const DOWNSIDE_DETECTOR_IDS: readonly string[] = DOWNSIDE_DETECTORS.map((d) => d.indicator.id);

// --- EW rel-strength legs (ew AND-gate, 2026-08-15) --------------------------
//
// RS_SMH/RS_XLK: the same-day rel-strength siblings of the DB_* detectors — the X/SPY ratio
// scored vs its own MA50 (`relStrengthBreakReadingSeries`, %-spread decision). Same GLOBAL
// channel, `thresholds: {}` (bespoke scorer), NO family/danger membership, and deliberately
// NOT rows in DOWNSIDE_DETECTORS (membership there IS the ew notify roster; the AND-gate
// pairing rides `RS_LEG_OF` instead — Stage 2 wires it).
export const RS_SMH: Indicator = withMultipliedThresholds({
  id: "RS_SMH",
  label: "SMH rel-strength",
  longLabel: "Rel-strength breakdown - SMH/SPY vs MA50",
  series: "SMH", // ratio numerator; SPY is the 2nd scorer input (denominator)
  channel: "GLOBAL",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread", // % vs MA50 of the SMH/SPY ratio — the scorer's own spread transform
    window: RS_MA_WINDOW,
    ...rsBands("RS_SMH"),
    label: "SMH/SPY % vs MA50",
    unit: "%",
  },
});

export const RS_XLK: Indicator = withMultipliedThresholds({
  id: "RS_XLK",
  label: "XLK rel-strength",
  longLabel: "Rel-strength breakdown - XLK/SPY vs MA50",
  series: "XLK", // ratio numerator; SPY is the 2nd scorer input (denominator)
  channel: "GLOBAL",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread",
    window: RS_MA_WINDOW,
    ...rsBands("RS_XLK"),
    label: "XLK/SPY % vs MA50",
    unit: "%",
  },
});

// KBE_RS bank-equity rel-strength (KBE/SPY vs MA50) — F6-shape (scoreRelStrengthBreak, PRICE_SCORERS). CONTEXT; seated uT
// (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial. Cuts KBE_RS_DESCRIPTOR ([USER] hand-set).
export const KBE_RS: Indicator = withMultipliedThresholds({
  id: "KBE_RS",
  // EU-Fin top-10 seat. ⚠ Deliberately NOT EXSH_GATE's 2008 floor — `[USER]` 2026-09-29: 5y only, to bound DB growth.
  backfill: { years: EUFIN_BACKFILL_YEARS },
  label: "KBE rel-strength",
  longLabel: "Rel-strength breakdown - KBE/SPY vs MA50",
  series: "KBE", // ratio numerator; SPY is the 2nd scorer input (denominator)
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread",
    window: RS_MA_WINDOW,
    ...rsBands("KBE_RS"),
    label: "KBE/SPY % vs MA50",
    unit: "%",
  },
});

// INS_RS European-insurer rel-strength (EXH5.DE/EXSA.DE vs MA50) — exact KBE_RS shape (scoreRelStrengthBreak, PRICE_SCORERS).
// CONTEXT; seated uT (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial. Insurers are ~31% of
// the held EXSH basket. Cuts: INS_RS_DESCRIPTOR.
export const INS_RS: Indicator = withMultipliedThresholds({
  id: "INS_RS",
  // EU-Fin top-10 seat. 5y like KBE_RS (NOT EXSH_GATE's 2008 floor) — bounds DB growth.
  backfill: { years: EUFIN_BACKFILL_YEARS },
  label: "Insurers rel-strength",
  longLabel: "Rel-strength breakdown - EXH5/EXSA vs MA50",
  series: "EXH5.DE", // ratio numerator; EXSA.DE is the 2nd scorer input (denominator)
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread",
    window: RS_MA_WINDOW,
    ...rsBands("INS_RS"),
    label: "EXH5/EXSA % vs MA50",
    unit: "%",
  },
});

// EXSH_GATE EU-Fin re-entry gate ([USER] rule B, 2026-10-06) — the held fund's own 3-check trend/RS read
// (EXSH.DE vs MA50 + MA200, EXSH.DE/EXSA.DE vs MA50); retires the EXSH rel-strength + MA200-trend rows into one. CONTEXT;
// seated uT (EU-Fin cell) — per-leg only (PER_LEG_ONLY_MEMBERS), never moves the dial. Rule + cuts:
// EXSH_GATE_DESCRIPTOR. The plotted decision is close % vs MA200 (red band at the cross); NO amber band —
// AMBER comes from the two short-window checks, which have no line on this axis.
export const EXSH_GATE: Indicator = withMultipliedThresholds({
  id: "EXSH_GATE",
  backfill: { years: EXSH_GATE_BACKFILL_YEARS },
  label: "EXSH gate",
  longLabel: "EU-Fin re-entry gate - EXSH vs MA50/MA200 + EXSH/EXSA vs MA50",
  series: "EXSH.DE", // the fund's close; EXSA.DE is the 2nd scorer input (rel-strength denominator)
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (exshGateReadingSeries), not classify()
  unit: "",
  derived: {
    kind: "maSpread",
    window: EXSH_GATE_DESCRIPTOR.scorer.constants.trendWindow,
    amber: null,
    red: EXSH_GATE_DESCRIPTOR.scorer.constants.red,
    label: "% vs MA200",
    unit: "%",
  },
});

// AT1 bank sub-credit proxy (XAT1.DE/EXHA.DE vs MA50, btp-bund S3 Q4) — KBE_RS shape: the Invesco USD AT1 CoCo
// ETF (EUR-hedged, ~3y to call; its rate leg is USTs) over the Bund ETF (EXHA, eb.rexx Govt Germany — [USER] 2026-10-11) — the ratio cancels risk-on/off
// direction, NOT duration (2026-09-29 review), so a break is sector-wide sub-debt repricing (CS 2023).
// GLOBAL, seated cr (EU-Fin cell only, eufin-overlap R7) — per-leg only (PER_LEG_ONLY_MEMBERS): never
// BAND_DRIVING, never the dial's `legP`. Cuts: the pair on `AT1_DESCRIPTOR` ([USER]-hand-set S4, via `RS_CUT_OVERRIDES`).
export const AT1: Indicator = withMultipliedThresholds({
  id: "AT1",
  backfill: { years: AT1_BACKFILL_YEARS },
  label: "AT1 rel-strength",
  longLabel: "Bank sub-credit - XAT1/EXHA vs MA50",
  series: "XAT1.DE", // ratio numerator; EXHA.DE is the 2nd scorer input (denominator)
  channel: "GLOBAL",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread",
    window: RS_MA_WINDOW,
    ...rsBands("AT1"),
    label: "XAT1/EXHA % vs MA50",
    unit: "%",
  },
});

// MU_RS Micron rel-strength (MU/SMH vs MA50) — KBE_RS shape. CONTEXT, display-only: no weight/family, never the dial.
// Cuts borrow the rsCuts default (no RS_CUT_OVERRIDES row) pending [USER] hand-set off the detail chart.
export const MU_RS: Indicator = withMultipliedThresholds({
  id: "MU_RS",
  label: "MU rel-strength",
  longLabel: "Rel-strength breakdown - MU/SMH vs MA50",
  series: "MU", // ratio numerator; SMH is the 2nd scorer input (denominator)
  backfill: { years: SEMIS_BACKFILL_YEARS }, // Semis top-10 seat
  channel: "CONTEXT",
  thresholds: {}, // bespoke scorer (scoreRelStrengthBreak), not classify()
  unit: "",
  derived: {
    kind: "maSpread",
    window: RS_MA_WINDOW,
    ...rsBands("MU_RS"),
    label: "MU/SMH % vs MA50",
    unit: "%",
  },
});

// JPT Japan equity trend (TOPIX 1306.T vs MA200) — GT shape, borrows GT's cuts. CONTEXT, display-only: no weight/family.
export const JPT: Indicator = withMultipliedThresholds({
  id: "JPT",
  label: "Japan trend",
  longLabel: "Japan equity trend (TOPIX 1306.T vs MA200)",
  series: "1306.T",
  channel: "CONTEXT",
  thresholds: {}, // bespoke maSpread scorer (globalTrendReadingSeries); bands ride `derived`
  unit: "",
  derived: {
    kind: "maSpread",
    window: MA_WINDOW,
    amber: GT_AMBER,
    red: GT_RED,
    label: "% vs MA200",
    unit: "%",
  },
});

/**
 * The RS legs as ONE table (the `DOWNSIDE_DETECTORS` shape): `detector` is the DB_* id the leg
 * gates (Stage 2's `RS_LEG_OF` derives off it — never restated), `symbols` = [numerator, SPY]
 * drives both the run-cycle fetch union and the backfill feed. ORDER mirrors
 * DOWNSIDE_DETECTORS (SMH→XLK); `src/registry.test.ts` pins the derived id sets.
 */
export const RS_LEGS = [
  { id: "RS_SMH", indicator: RS_SMH, detector: "DB_SMH", symbols: ["SMH", "SPY"] },
  { id: "RS_XLK", indicator: RS_XLK, detector: "DB_XLK", symbols: ["XLK", "SPY"] },
] as const;

/** The RS reading/persisted id set, derived from RS_LEGS (the DOWNSIDE_DETECTOR_IDS pattern). */
export const RS_LEG_IDS: readonly string[] = RS_LEGS.map((l) => l.indicator.id);

/** detector id → its RS leg id (the ew AND-gate pairing), DERIVED from RS_LEGS — never restated. */
export const RS_LEG_OF: Readonly<Record<string, string>> = Object.fromEntries(
  RS_LEGS.map((l) => [l.detector, l.indicator.id]),
);

//
// Slow "bubble-state" track (Phase 3 Stage 1B) — the two 0–2 composite contributors
// scored in slow.ts via bespoke scorers (scorePriceAccel/scoreComplacency), NOT the
// FRED loop and NOT scoreIndicator, so they are NOT in INDICATORS.
//
// They ARE declared `volatility` family members (`families.ts`, the 2026-07-15 cp→vl fold) —
// but that membership is DISPLAY-ONLY, and the enforcement point is exactly one thing: the
// `DIAL_FAMILIES` table in `danger-ladder.ts` (re-exported by `dial-assembly.ts`), which is
// `GLOBAL_FAMILIES` minus these ids. `danger-ladder.ts`'s `FAMILY_MEMBERS` derives from it too
// (Stage 2.1), so the danger engine's depth/N-M folds see the same exclusion.
// Every fold that can reach the T1 dial or the notify band reduces against THAT table — the
// shared `assembleDial` seam (cron + /api/lab live), /api/lab's `?s=` scenario panel,
// `replay.ts`'s per-close fold, the `sim:notify` oracle, and the three OFFLINE replay probes
// that reproduce the dial off persisted rows: `scripts/probe-top2-position.ts`,
// `scripts/probe-cash-overlay.ts` and `scripts/probe-leader-split.ts` (they walk the SAME persisted rows /api/lab
// does, slow legs included, so a GLOBAL_FAMILIES fold there quotes an unreachable rung/band —
// fixed 2026-07-20). They DO still reach every
// display fold, which reduces against the full GLOBAL_FAMILIES: /lab's board tiles, ledger
// chips and replay coverage strip all render them as `volatility` members. So the claim is
// "absent from the DIAL_FAMILIES table", not "absent everywhere" — a fold that reduced these
// ids against GLOBAL_FAMILIES and then drove a band WOULD couple them, which is the B-11 bug.
// (Slow→fast coupling is test-pinned broken — `dashboard.notify.test.ts` "on a no-dial run the
// armed bit is INERT".) See `danger-ladder.ts`'s DIAL_FAMILIES for the full ruling
// (`families.ts` carries only a ⚠ note on why it CANNOT host the table — a runtime cycle).
//
// They live here ONLY so /api/series (which 400s unknown
// ids) and /status can label/serve the persisted SLOW readings. `channel: "SLOW"`
// keeps them out of the retired verdict engine's byChannel roll-ups, and /status filters the SLOW
// channel out so they never pollute the fast readings panel. `thresholds: {}` — the
// 0–2 score is computed in slow.ts, not via the level/velocity thresholds. The `id`s
// MUST match the SlowComponent ids the scorers emit (slow.ts), so the persisted
// readings line up with these metadata rows.
export const SLOW_INDICATORS: Indicator[] = ([
  {
    id: "price-accel",
    label: "Price accel",
    longLabel: "Price acceleration (QQQ 63d return %ile)",
    series: "QQQ", // informational: scored from the price feed in slow.ts, not fetched here
    channel: "SLOW",
    thresholds: {},
    unit: "", // a 0–2 composite score, not a quoted level
  },
  // `complacency` is persisted as its two observability legs (the scored 0–2 component
  // is never written as a row). Each leg carries a continuous metric: VIX percentile and
  // QQQ distance-to-252d-high fraction.
  {
    id: "complacency-vix",
    label: "VIX %ile",
    longLabel: "Complacency - VIX percentile",
    series: "VIXCLS", // informational: scored from VIXCLS in slow.ts
    channel: "SLOW",
    thresholds: {},
    unit: "",
  },
  {
    id: "complacency-high",
    label: "Dist to 12m high",
    longLabel: "Complacency - distance to 252d high",
    series: "QQQ", // informational: scored from the price feed in slow.ts
    channel: "SLOW",
    thresholds: {},
    unit: "",
  },
  // T3.2 duration-of-calm (UNVALIDATED starting prior — backtest-gated). An OBSERVABILITY-only
  // leg: scored in slow.ts (scoreDurationOfCalm over VIXCLS run-length below its
  // median), persisted so /api/series + /status can label the row. Never feeds the slow band.
  {
    id: "complacency-duration",
    label: "Calm duration",
    longLabel: "Complacency - duration of calm (VIX run-length below median)",
    series: "VIXCLS", // informational: scored from VIXCLS in slow.ts
    channel: "SLOW",
    thresholds: {},
    unit: "",
  },
] as Indicator[]).map((ind) => withMultipliedThresholds(ind));

/**
 * The SLOW leg ids as a lookup set — derived from SLOW_INDICATORS so it can never drift from
 * the declaration. Consumed by `assembleDial` to enforce display-only family membership
 * (the legs render on /lab's board but must not reach the dial or the notify band).
 */
export const SLOW_INDICATOR_IDS: ReadonlySet<string> = new Set(SLOW_INDICATORS.map((i) => i.id));

/** Value re-entry `t2-kbe`: KBE worst peak-to-trough inside `window` closes stays above −`drop` — read by `probe-value-tranches.ts`. */
export const KBE_WORST_DROP = { window: 21, drop: 0.2 } as const;
/** Value escalation-box near-miss share — `VALUE_RULES.ESC_NEAR`; KBE's amber line sits at −drop·(1 − it). */
export const VALUE_ESC_NEAR = 0.25;

// Pension drawdown track (store-backed-history plan) — the three RAW legs the EUR
// blended-drawdown is computed from, persisted so /api/series can chart them. Like the
// SLOW rows they live here ONLY for labels + /series (which 400s unknown ids); `channel:
// "PENSION"` keeps them out of the retired verdict engine (never in INDICATORS/PRICE_SCORERS) and
// /status filters the channel out so they never pollute the fast panel. `thresholds: {}`
// — the legs have no Green/Amber/Red concept; the drawdown band is computed in pension.ts.
// The `id`s MUST match the series ids the run loop (`run-seeds.ts`/`tracks.ts`) persists + reads (SPY/DEXUSEU/SP500IT).
//
// SPY/VEA/SP500IT (each ÷ DEXUSEU) are the SCORING sleeves — weighted by the effective-dated
// book (`pension_holdings.ts`: SPY/VEA 50/50 to 2026-07-21, 100% SP500IT after), chain-linked
// into the one blended band + calibration series that reaches back to 2007. (The short-history
// `CHSI.DE` holding row was removed 2026-09-05 — it duplicated the VEA sleeve.)
//
// A currency `unit` marks a row whose stored values ARE a currency amount, so the detail chart prefixes them
// (formatValue): "€" for the EUR rows (the LEGP_* legs, XDEV), "$" for the USD adjusted closes (SPY/SP500IT/
// VWO/VGK, and KBE/AMAT/COPPER below). DEXUSEU stays unitless — a rate, not an amount.
export const PENSION_INDICATORS: Indicator[] = ([
  { id: "SPY", label: "S&P 500 SPY", longLabel: "Pension US leg - SPY (USD adj close)", series: "SPY", channel: "PENSION", thresholds: {}, unit: "$" },
  { id: "DEXUSEU", label: "EUR/USD EURUSD=X", longLabel: "Pension FX - USD per EUR (EURUSD=X)", series: "DEXUSEU", channel: "PENSION", thresholds: {}, unit: "" },
  // S&P 500 IT leg — NO scorer on this row (thresholds:{}), like every PENSION entry: it carries no
  // Green/Amber/Red state of its own. Stored under id `SP500IT`, fetched as ticker
  // `XLK` (Tech Select SPDR, ~1998) — the same store-id≠fetch-ticker split `DEXUSEU` uses (stored
  // DEXUSEU, fetched EURUSD=X). "No scorer" describes this row: it carries no Green/Amber/Red state,
  // charted for attribution under the portfolio drawdown detail picker.
  { id: "SP500IT", label: "S&P IT XLK", longLabel: "Pension S&P 500 IT leg - XLK (USD adj close)", series: "SP500IT", channel: "PENSION", thresholds: {}, unit: "$" },
  // EU-Fin — the HELD sleeve since 2026-07-31 (European financials, `EXSH.DE` on Xetra). Its store
  // series is the SCOREBOARD-owned `LEGP_EUFIN` (`legCloseId`, scoreboard.ts): a CHAINED EUR total-return level
  // seeded at a real close (above the quote by any payouts since), written by `seedLegClosesOnCron`, never by the pension track.
  // The registry id IS that store id because
  // `/api/series` reads `store.getSeries(indicator.id)` and serves the stored € level. This row exists
  // for the detail picker + `/api/series` only (ruled `[USER]` 2026-09-04: the held sleeve must be
  // selectable under Portfolio drawdown). `/status` serves its ETFs card via the `ETF_CARD_IDS` bridge
  // (R7a: value/`return20d` served null), not the run rows. `unit: "€"` like XDEV: EUR-native.
  { id: "LEGP_EUFIN", label: "EU-Fin EXSH", longLabel: "European financials - EXSH.DE (EUR)", series: "EXSH.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  // Health — a COMPARATOR sleeve of the rotation ladder (`QDVG.DE`, S&P 500 Health Care on
  // Xetra). Same shape as LEGP_EUFIN above: its store series is the SCOREBOARD-owned `LEGP_HEALTH`
  // (`legCloseId`, scoreboard.ts) — a CHAINED EUR level seeded at a real close, written by
  // `seedLegClosesOnCron`, never by the pension track. The registry id IS that store id because
  // `/api/series` reads `store.getSeries(indicator.id)` and serves the stored € level. This row exists
  // for the detail picker + `/api/series`; `/status` serves its ETFs card via the `ETF_CARD_IDS` bridge
  // (R7a: value/`return20d` null in the served body). `unit: "€"` like EXSH/XDEV: EUR-native.
  { id: "LEGP_HEALTH", label: "Health QDVG", longLabel: "S&P 500 Health Care - QDVG.DE (EUR)", series: "QDVG.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  // OFF-LADDER commodities detail row (`LEGP_COMMOD`, scoreboard.ts `offLadderLegCloseId`): a chained
  // EUR level of LYTR.DE, display-only under the ETFs card — NOT a ladder leg, weight, sleeve or blend.
  { id: "LEGP_COMMOD", label: "Commodities LYTR", longLabel: "Commodities - LYTR.DE Bloomberg Energy & Metals EW (EUR)", series: "LYTR.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  // OFF-LADDER AW-Fundamental detail row (`LEGP_RAFI`, scoreboard.ts `offLadderLegCloseId`): a chained
  // EUR level of PSWD.DE, display-only under the ETFs card — NOT a ladder leg, weight, sleeve or blend.
  { id: "LEGP_RAFI", label: "AW Fundam PSWD", longLabel: "AW Fundamental - PSWD.DE Invesco FTSE RAFI All-World 3000 (EUR)", series: "PSWD.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  // The remaining ladder legs, same shape as LEGP_HEALTH (`legCloseId`, scoreboard.ts; label = `sleeveLabel`).
  // SEMIS/EXUS before the held fund's first close are the USD proxy ÷ EUR/USD, joined at it (`spliceProxyCloses`).
  { id: "LEGP_SEMIS", label: "Semis SEC0", longLabel: "Semiconductors - SEC0.DE (EUR; before 2021-08-06 SMH ÷ EUR/USD)", series: "SEC0.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  { id: "LEGP_SPIT", label: "S&P IT QDVE", longLabel: "S&P 500 Information Technology - QDVE.DE (EUR)", series: "QDVE.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  { id: "LEGP_EM", label: "EM IS3N", longLabel: "Emerging markets - IS3N.DE (EUR)", series: "IS3N.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  { id: "LEGP_SPX", label: "S&P 500 SXR8", longLabel: "S&P 500 - SXR8.DE (EUR)", series: "SXR8.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  { id: "LEGP_EXUS", label: "ex-US CHSI", longLabel: "Developed ex-US - CHSI.DE (EUR; before 2025-03-03 VEA ÷ EUR/USD)", series: "CHSI.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  { id: "LEGP_STAPLES", label: "Staples ZPDS", longLabel: "US Consumer Staples Select Sector - ZPDS.DE (EUR)", series: "ZPDS.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  // COMPARATOR legs (ruled `[USER]` 2026-08-02) — sleeves the book could hold but does not
  // weight today, so they never enter the blend and can never gate the portfolio band.
  // Same PENSION channel, same
  // no-scorer shape (`thresholds: {}`) as every row above; NOT a new channel and NOT a new
  // block. `SPY` is a comparator too and is already registered above — never a second id.
  // Labels on this card group are the LADDER LEG NAMES (`LEG_FIELD[].sleeve`, danger-ladder.ts)
  // where a sleeve maps to a leg (ruled `[USER]` 2026-09-05); `VGK`, the one leg-less row, carries its
  // index name (`Dev Europe`). The Semis/ex-US legs chart as `LEGP_SEMIS`/`LEGP_EXUS` above.
  { id: "VWO", label: "EM VWO", longLabel: "Pension comparator - emerging markets, VWO (USD adj close)", series: "VWO", channel: "PENSION", thresholds: {}, unit: "$" },
  { id: "VGK", label: "Dev Europe VGK", longLabel: "Pension comparator - developed Europe, VGK (USD adj close)", series: "VGK", channel: "PENSION", thresholds: {}, unit: "$" },
  // World Value — the ACTUAL Value holding the ladder prices, added 2026-08-08; it took over
  // `VTV`'s slot in `COMPARATOR_SLEEVES` (`pension_holdings.ts`). `VTV` (US large-cap value, a
  // decorative stand-in) was REMOVED outright 2026-09-04 (ruled `[USER]`): no registry row, no
  // sleeve, no fetch — its prod `readings` rows are orphaned history. `unit: "€"` because the stored
  // values ARE euros (Xetra close), never a USD line divided by the FX leg.
  { id: "XDEV", label: "Value XDEV", longLabel: "Pension comparator - MSCI World Value, XDEV.DE (EUR close)", series: "XDEV.DE", channel: "PENSION", thresholds: {}, unit: "€" },
  // Value-ladder inputs ([USER]): same comparator shape; `probe:value-tranches` reads them.
  {
    id: "KBE", label: "Banks KBE", longLabel: "Value-ladder input - US banks, KBE (USD adj close)", series: "KBE", channel: "PENSION", thresholds: {}, unit: "$",
    // `api/series.ts` stamps `decision` on read (stored rows carry none).
    derived: {
      kind: "worstDrop",
      window: KBE_WORST_DROP.window,
      amber: -KBE_WORST_DROP.drop * (1 - VALUE_ESC_NEAR),
      red: -KBE_WORST_DROP.drop,
      label: `worst ${KBE_WORST_DROP.window}-close drop`,
      unit: "%",
      displayOnly: true,
    },
  },
  // Display-only comparator reads of the value probe (never a criterion): Hynix vs Micron off their highs, AMAT:MU vs its MA, KRW/COPPER HIGH_N-close change.
  // Hynix-vs-MU + AMAT:MU tested as Semis re-entry criteria 2026-10-24: no post-2016 edge → stay display-only; promoting one owes a fresh lead test first.
  // Native-currency vendor closes served at their stored level: USD ones carry `unit: "$"`; the KRW close and the two FX rates stay unitless.
  { id: "HYNIX", label: "SK Hynix", longLabel: "Value-ladder input - SK Hynix, 000660.KS (KRW close)", series: "000660.KS", channel: "PENSION", thresholds: {}, unit: "" },
  { id: "AMAT", label: "Applied Mat AMAT", longLabel: "Value-ladder input - Applied Materials, AMAT (USD adj close)", series: "AMAT", channel: "PENSION", thresholds: {}, unit: "$" },
  { id: "KRW", label: "USD/KRW", longLabel: "Value-ladder input - won per US dollar, KRW=X", series: "KRW=X", channel: "PENSION", thresholds: {}, unit: "" },
  { id: "COPPER", label: "Copper HG", longLabel: "Value-ladder input - COMEX copper front month, HG=F", series: "HG=F", channel: "PENSION", thresholds: {}, unit: "$" },
] as Indicator[]).map((ind) => withMultipliedThresholds(ind));

// VIX-bottom track (Bug 4) — the two RAW off-ladder legs the bottom panel charts,
// persisted so /api/series can draw their detail charts. Exactly the PENSION_INDICATORS
// pattern: raw levels with NO Green/Amber/Red scorer (`thresholds: {}`), `channel:
// "BOTTOM"` keeps them out of the retired verdict engine (never in INDICATORS/PRICE_SCORERS) and
// /status filters them out (track-derived) so they never pollute the fast panel. The
// bottom BAND itself is computed in bottom.ts from the aligned term structure — these
// legs carry no state. `id`s MUST match the series ids tracks.ts persists (VIX/VIX3M).
export const BOTTOM_INDICATORS: Indicator[] = ([
  // `VIX spot`, not `VIX`: R5 (the SCORED VIX) already owns the bare name, and the registry's
  // uniqueness guard (registry.test.ts) forces the disambiguation at edit time rather than in a
  // 03:00 push line. Both are front-month VIX and — since the 2026-07-26 repoint (IS-6 rung A) —
  // both ride the SAME series (`VIXCLS`); only R5 scores. The duplicate `series` is
  // deliberate: the registry's uniqueness guard binds short NAMES, not feed ids.
  { id: "VIX", label: "VIX spot", longLabel: "VIX bottom leg - front-month implied vol (VIXCLS)", series: "VIXCLS", channel: "BOTTOM", thresholds: {}, unit: "" },
  { id: "VIX3M", label: "VIX3M", longLabel: "VIX bottom leg - 3-month implied vol (VXVCLS)", series: "VXVCLS", channel: "BOTTOM", thresholds: {}, unit: "" },
] as Indicator[]).map((ind) => withMultipliedThresholds(ind));

/**
 * Price-feed scorer table (scorer-as-data) — the single source of truth for the
 * symbol→scorer pairing the run loop used to hardcode. `inputs` drives the fetch
 * set (run-dbfirst.ts fetches the deduped union); `series` returns the per-day reading
 * series (oldest→newest), LAST element = the live commit reading; the rest feeds the gap-fill sweep.
 */
interface PriceScoreSpec {
  indicator: Indicator;
  inputs: string[]; // price symbols to fetch (union drives the fetch set)
  /** Per-day reading series (oldest→newest); LAST = the live commit reading. */
  series: (bySymbol: Record<string, Observation[]>) => Reading[];
  /** Deep: the whole series is backfilled (`backfillHistory`), not only the gap-fill window. */
  backfill?: true;
  /** Soft: a failed fetch of a symbol ONLY soft rows consume drops these rows, not the batch (`SOFT_PRICE_SYMBOLS`). */
  soft?: true;
  /** Input symbol whose close dates are this row's feed-date grid; omitted ⇒ QQQ's US calendar (run-cycle-confirmers `priceGrid`). */
  calendar?: string;
}
/**
 * FETCH DEPTH — the breadth band's history problem, and its fix (2026-08-21).
 *
 * `scoreBreadth`'s dynamic band needs `BREADTH_MIN_CLOSES` aligned closes before it can form
 * a single confirmed state, but the default price fetch serves `LOOKBACK_DAYS` = 400 CALENDAR days
 * (~275 closes). From the dynamic-percentile band until the guard-light repair the F5 row THREW on every prod run
 * and run-cycle's single `degrade()` wrapper took the whole price batch with it; after the repair it
 * failed soft but scored GREEN forever (NaN cuts). Neither is a working indicator.
 *
 * So these four symbols — F5's QQQ/QQQE and SPCONC's SPY/RSP, both legs of each pair — are fetched
 * DEEP. Precedent: `confirmers.ts` already deep-fetches HG=F/GC=F for the same reason. Note a
 * GLOBAL `LOOKBACK_DAYS` bump would not have FIXED it either: the shallow closes-feed fetch is hard-coded
 * `range=2y` (~500 closes), which since the 2026-08-29 rolling retune sits ABOVE the floor — so the
 * deep fetch now buys RANK HEADROOM (a live run off its first finite cut day), not the difference
 * between scoring and throwing. Same conclusion, different reason; do not re-argue it from the floor.
 *
 * Every OTHER symbol stays shallow. The deep legs are supersets, so the scorers that share them
 * (F6 SMH·SPY, RS_SMH/RS_XLK) are unmoved — `alignByDate` intersects against a shallow leg — and
 * `run-cycle`'s `qqq` handoff to the slow track only gains headroom over its `MIN_ACCEL_OBS` throw.
 */
export const DEEP_PRICE_INPUTS: ReadonlySet<string> = new Set(["QQQ", "QQQE", "SPY", "RSP"]);

/**
 * Calendar days to request for a `DEEP_PRICE_INPUTS` symbol. DERIVED from
 * `BREADTH_MIN_CLOSES`, never restated: 1.5× the required closes (headroom over the first finite
 * cut day) converted at 252 closes/365 days. Raising HIGH_WINDOW/BREADTH_CUT_WINDOW/CONFIRM_CLOSES
 * widens this in the same edit — that is the point of deriving it.
 */
export const BREADTH_LOOKBACK_DAYS = Math.ceil((BREADTH_MIN_CLOSES * 1.5 * 365) / 252);

/**
 * BR_* — the DB-first backing store ids for the three deep breadth symbols with NO existing raw-close
 * id (§6.2): one `readings` id per symbol, raw adjusted
 * closes. `channel: "BREADTH"` + deliberate ABSENCE from ALL_INDICATORS keeps them off every scored
 * path / card / census (§0.7). SPY is NOT here — it reuses its own `SPY` id READ-ONLY (§6.2). The
 * `series` label is the fetch symbol; `id` is what run-cycle persists + reads. Never `withMultipliedThresholds`d.
 */
export const BR_QQQ: Indicator = { id: "BR_QQQ", label: "QQQ close", longLabel: "Breadth input - Nasdaq-100 QQQ (USD adj close)", series: "QQQ", channel: "BREADTH", thresholds: {}, unit: "" };
export const BR_QQQE: Indicator = { id: "BR_QQQE", label: "QQQE close", longLabel: "Breadth input - Nasdaq-100 equal-weight QQQE (USD adj close)", series: "QQQE", channel: "BREADTH", thresholds: {}, unit: "" };
export const BR_RSP: Indicator = { id: "BR_RSP", label: "RSP close", longLabel: "Breadth input - S&P 500 equal-weight RSP (USD adj close)", series: "RSP", channel: "BREADTH", thresholds: {}, unit: "" };

/** Each DEEP breadth symbol → the `readings` id its closes store under. QQQ/QQQE/RSP get their minted
 *  BR_* id; SPY reuses the `SPY` id it shares with the comparator chart (`BREADTH_READ_ONLY` gates the
 *  write off — §6.2), which the input-series cron now keeps fresh (`INPUT_SERIES`, `SPY` row). */
export const BREADTH_STORE_IDS: Readonly<Record<string, Indicator>> = {
  QQQ: BR_QQQ,
  QQQE: BR_QQQE,
  RSP: BR_RSP,
  SPY: PENSION_INDICATORS.find((i) => i.id === "SPY")!,
};

/** Deep breadth symbols the breadth path reads but NEVER writes — the `SPY` id has its own dedicated
 *  cron writer (`seedInputSeriesOnCron` off the `INPUT_SERIES` `SPY` row; before J4 it was the pension
 *  track), so a second writer here is exactly what §0.3/§0.8 forbid (§6.2). Losing that sole writer
 *  re-opens the DB-first tail-arm gap — pinned by `run-seeds.input-series.test.ts`. */
export const BREADTH_READ_ONLY: ReadonlySet<string> = new Set(["SPY"]);

/** Raw adjusted closes → GREEN raw `Reading[]` for a BR_* store id (the `dbFirstOrDirect` `score`): no
 *  Green/Amber/Red concept, `delta20` the 20-close change, mirroring `priceLegReadingSeries`' stored shape. */
export function breadthCloseReadingSeries(indicator: Indicator, obs: Observation[]): Reading[] {
  return obs.map((o, i) => ({
    indicator,
    date: o.date,
    level: o.value,
    delta20: i >= 20 ? o.value - obs[i - 20]!.value : 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
    decision: null,
  }));
}

/** A breadth row's full series, `[]` below the rankable window (`breadthBandRanked`). */
function breadthTail(ind: Indicator, a: Observation[] = [], b: Observation[] = []): Reading[] {
  return breadthBandRanked(a, b) ? breadthReadingSeries(ind, a, b) : [];
}

export const PRICE_SCORERS: PriceScoreSpec[] = [
  {
    indicator: F4,
    inputs: ["SMH", "NVDA"],
    series: (s) => withNewest(semisReadingSeries(F4, s.SMH ?? [], s.NVDA ?? []), scoreSemis(F4, s.SMH!, s.NVDA!)),
  },
  // GUARD-LIGHT, for the reason spelled out on the SPCONC row below — F5 hit it in prod.
  // Since the dynamic-percentile band `scoreBreadth` needs `BREADTH_MIN_CLOSES` aligned
  // closes, but the live fetch window is `LOOKBACK_DAYS` = 400 CALENDAR
  // days (~275 closes), so the bare row threw `[F5] need 506 aligned closes, got 275` on EVERY run
  // (506 was the floor THEN; `BREADTH_MIN_CLOSES` is 380 since the rolling retune — the quote is the
  // incident's own text, not a live value)
  // and the one `degrade()` wrapper took the whole price batch down with it: F4/F5/SPCONC/F6/F8/F13/
  // NVDA and both DB_*/RS_* legs vanished from `readings`, which is what darkened the /lab `ew`
  // column (fallback row) and the DB_SMH card ("no reading yet") from 2026-08-20 to 2026-08-21.
  // `breadthReadingSeries` itself emits only ranked (finite-cut) days; `breadthBandRanked` (the
  // `BREADTH_MIN_CLOSES` guard as a soft predicate) DROPS the leg below the full floor —
  // the card reads "no reading yet", not a false calm. Stage 8's `BREADTH_LOOKBACK_DAYS` deep feed
  // keeps the live path above the window; this guard is the fail-soft floor for a short/404 feed.
  {
    indicator: F5,
    inputs: ["QQQ", "QQQE"],
    series: (s) => breadthTail(F5, s.QQQ, s.QQQE),
  },
  // RSP is a NET-NEW symbol on the prices.ts path; SPY is already fetched (F6's 2nd input).
  // `inputs` IS the fetch-set SSoT, so this row is what wires the RSP fetch.
  //
  // GUARD-LIGHT, deliberately — the same precaution run-dbfirst.ts already takes for the DB_* detectors.
  // `scoreBreadth` ends in `latest()`, which THROWS below HIGH_WINDOW + CONFIRM_CLOSES aligned
  // closes, and every spec's `score()` runs inside run-dbfirst.ts's single `degrade()` wrapper. A bare
  // `scoreBreadth` row would therefore let ONE short/404ing RSP fetch collapse the whole price
  // batch — F4/F5/F6/F8/F13 AND both downside detectors, so the new `ew` floor goes dark on
  // exactly the run where a feed is unhealthy. RSP has no fetch history in this repo at all, so
  // that is a live risk, not a hypothetical. Returning `[]` drops only this leg.
  // Same warm-up guard as F5 (kept consistent): drop the leg below the rankable window rather than
  // publishing a NaN-cut GREEN.
  {
    indicator: SPCONC,
    inputs: ["SPY", "RSP"],
    series: (s) => breadthTail(SPCONC, s.SPY, s.RSP),
  },
  {
    indicator: F6,
    inputs: ["SMH", "SPY"],
    series: (s) => withNewest(relStrengthBreakReadingSeries(F6, s.SMH ?? [], s.SPY ?? []), scoreRelStrengthBreak(F6, s.SMH!, s.SPY!)),
  },
  // KBE_RS — same scorer/shape as F6, KBE÷SPY. KBE is the ONLY new fetch symbol (SPY already fetched).
  // Soft + guard-light: an empty leg yields `[]`, never a throw into the batch's `degrade()`;
  // `.slice(-1)` keeps the live row length-1 (no per-run backfill), like the RS_LEGS `.at(-1)`.
  {
    indicator: KBE_RS,
    inputs: ["KBE", "SPY"],
    soft: true,
    series: (s) => relStrengthBreakReadingSeries(KBE_RS, s.KBE ?? [], s.SPY ?? []),
  },
  // INS_RS — KBE_RS shape, EXH5.DE÷EXSA.DE. EXH5.DE is the ONLY new fetch symbol (EXSA.DE already fetched for
  // EXSH_GATE). Both Xetra, keyless-only by suffix. Soft + guard-light: an empty leg yields `[]`.
  {
    indicator: INS_RS,
    inputs: ["EXH5.DE", "EXSA.DE"],
    soft: true,
    calendar: "EXH5.DE", // Xetra closes, not QQQ's US calendar
    series: (s) => relStrengthBreakReadingSeries(INS_RS, s["EXH5.DE"] ?? [], s["EXSA.DE"] ?? []),
  },
  // EXSH_GATE — EXSH.DE shares LEGP_EUFIN's memoized fetchDailyCloses key; EXSA.DE is the rel-strength
  // denominator. Both Xetra, keyless-only by suffix. Soft + guard-light like KBE_RS: an empty leg yields `[]`.
  {
    indicator: EXSH_GATE,
    inputs: ["EXSH.DE", "EXSA.DE"],
    soft: true,
    calendar: "EXSH.DE", // Xetra closes, not QQQ's US calendar
    series: (s) => exshGateReadingSeries(EXSH_GATE, s["EXSH.DE"] ?? [], s["EXSA.DE"] ?? []),
  },
  // AT1 — XAT1.DE and EXHA.DE are BOTH Xetra symbols (Xetra, keyless-only by suffix); soft, so a failed fetch drops
  // only this row, never the batch.
  {
    indicator: AT1,
    inputs: ["XAT1.DE", "EXHA.DE"],
    soft: true, // same soft + guard-light form as KBE_RS/EXSH_GATE
    calendar: "XAT1.DE", // Xetra closes, not QQQ's US calendar
    series: (s) => relStrengthBreakReadingSeries(AT1, s["XAT1.DE"] ?? [], s["EXHA.DE"] ?? []),
  },
  // MU_RS — MU and SMH are both already fetched; soft + guard-light like KBE_RS.
  {
    indicator: MU_RS,
    inputs: ["MU", "SMH"],
    soft: true,
    series: (s) => relStrengthBreakReadingSeries(MU_RS, s.MU ?? [], s.SMH ?? []),
  },
  // JPT — Tokyo-listed 1306.T has no free source (prices.ts); soft + guard-light like MU_RS.
  {
    indicator: JPT,
    inputs: ["1306.T"],
    soft: true,
    calendar: "1306.T", // TSE closes, not QQQ's US calendar
    series: (s) => globalTrendReadingSeries(JPT, s["1306.T"] ?? []),
  },
  { indicator: F8, inputs: ["MU"], series: (s) => withNewest(memGateReadingSeries(F8, s.MU ?? []), scoreMemGate(F8, s.MU!)) },
  {
    indicator: F13,
    inputs: ["HYG", "LQD"],
    series: (s) => withNewest(creditAppetiteReadingSeries(F13, s.HYG ?? [], s.LQD ?? []), scoreCreditAppetite(F13, s.HYG!, s.LQD!)),
  },
  { indicator: NVDA, inputs: ["NVDA"], backfill: true, series: (s) => nvdaGateReadingSeries(NVDA, s.NVDA!) },
];
