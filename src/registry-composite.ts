/**
 * Registry — composite family (registry split, 2026-08-15): the multi-input composite ids
 * (R7/CG/VT/VTP/EURC/BUND/CQS/BONOS/FXH/GT/GB/DISP), the chart-only set, and the
 * composite-component vintage machinery (COMPOSITE_COMPONENTS/componentBackfillSeries).
 * Import surface: this file — edit and import here.
 */

import {
  type Cadence,
  type Indicator,
  type Observation,
  type Reading,
  VELOCITY_WINDOW,
} from "./domain-types.js";
import {
  // Detail-chart `derived` band values for CG (Stage 2a: cuts live on CG_DESCRIPTOR).
  CG_AMBER_RET,
  CG_RED_RET,
  // Stage 2b.2: shared windows live on PRICE_WINDOWS.
  MA_WINDOW,
  // Stage 2b.3: GT's bands live on GT_DESCRIPTOR, the GB constituent basket at module level.
  GT_AMBER,
  GT_RED,
  GB_SYMBOLS,
  HCX_SYMBOLS,
  // HCX/FDX chart-only `derived` lines: HCX highDist window; FDX ms50 window+cuts (single-sourced).
  HIGH_WINDOW,
  FDX_DESCRIPTOR,
  ESTR_DESCRIPTOR,
  ECISS_DESCRIPTOR,
  EURGBP_DESCRIPTOR,
} from "./family-descriptor-rows.js";
import { withMultipliedThresholds } from "./registry-fred.js";
import {
  EXPANDING_PERCENTILE_PREFIX_YEARS,
  ESTR_BACKFILL_YEARS,
  ECISS_BACKFILL_YEARS,
  EURGBP_BACKFILL_YEARS,
  EUFIN_BACKFILL_YEARS, BONOS_BACKFILL_YEARS, SEMIS_BACKFILL_YEARS } from "./backfill-depth.js";

// --- R7 bull-steepener composite confirmer (T2.1, 2026-07-01) ---------------
//
// The source's "dam breaks" leading signal: a curve un-inverting because the 2y is
// COLLAPSING (flight-to-safety) = active crisis, vs a healthy bear-steepener (long end
// rising on growth). A pure composite over three series already fetched for R1/R2/R3 —
// T10Y3M (headline term spread) + DGS2 (2y) + DGS10 (10y) — so it needs NO new feed; scored
// bespoke by scoreBullSteepener (scorers-composite.ts), NOT classify() (hence `thresholds: {}`). The
// state decomposes on the 2y vs 10y curve (Δ10y − Δ2y steepening driven by a dominant 2y
// drop), NOT the 3m-anchored T10Y3M — the 2y leads the 3m bill in the early crisis phase, so
// gating on the 3m-anchored spread was a false negative on the very signal R7 exists to catch
// (review 2026-07-02). It rides the RATE channel as a `confirmer: true`: the retired verdict engine
// credits its state-rank only once the RATE base (R1–R4) is already elevated (mirroring the
// FIN/EBP gate), so it can raise/confirm severity but never independently move the ladder.
// Bands are DYNAMIC per-day ranks (tail probabilities `BULL_AMBER_P`/`BULL_RED_P`, derived off
// R7_DESCRIPTOR in family-descriptor-rows.ts) — never a fixed yield magnitude. `series:
// "T10Y3M"` is the headline/primary (charted level = the term spread); DGS2 + DGS10 are the
// scorer's state inputs. NO `derived` descriptor (unlike G1/F4/F5/NVDA): the trigger is a
// 2-D condition (Δ2y AND Δ10y) that doesn't reduce to one band line — hence the bespoke
// `buildR7Chart` (chart-rail.ts), which draws both Δ20 legs + the four moving cuts on a
// secondary axis. Left the `"context-only"` sentinel 2026-08-14; not a single-`derived` viz.
export const R7: Indicator = withMultipliedThresholds({
  id: "R7",
  label: "Bull steepener",
  longLabel: "Bull steepener (2y-led)",
  series: "T10Y3M", // primary; DGS2 is the scorer's second input
  channel: "RATE",
  thresholds: {}, // bespoke composite scorer (scoreBullSteepener), not classify()
  confirmer: true,
  unit: "",
});

// --- CG copper/gold ratio (T2.2, 2026-07-04) --------------------------------
//
// UNVALIDATED starting prior — backtest-gated (Phase-2). The copper/gold ratio is a
// classic risk-off tell: a FALLING ratio (industrial copper demand weakening vs the
// safe-haven gold bid) leads growth scares. Scored bespoke by scoreRatioSpread
// (scorers-composite.ts) off CG_DESCRIPTOR, NOT classify() (hence `thresholds: {}`).
// TWO legs since 2026-08-08: the 20d ratio RETURN (velocity) and where the HG÷GC
// LEVEL sits in its own expanding distribution, joined by `combine: "split"` — RED
// needs BOTH legs RED, AMBER takes either. Both shapes live on CG_DESCRIPTOR.
//
// Channel is CONTEXT + `confirmer: true` — deliberately NOT GEO. CONTEXT is excluded
// from the base roll-up by construction (the retired verdict engine never sums it), so CG can NEVER
// solo-trigger an alert; a GEO auto-flag WOULD (an elevated GEO reading = +1 flag =
// solo WATCH). The Stage-3 GEO gate lets CG AMPLIFY an already-elevated GEO signal (it
// pairs with its commodity sibling oil G1, GEO) while remaining incapable of firing
// alone, and GEO is `crit: null` so it never reaches CRITICAL. BOTH legs' cuts are
// STARTING PRIORS derived off CG_DESCRIPTOR in family-descriptor-rows.ts (the single source):
// the return pair as CG_AMBER_RET/CG_RED_RET, the level pair as its `levelBand`
// percentiles. Run through the backtest harness before
// they sharpen the verdict, per Phase-2 discipline. `series: "HG=F"` is the primary/
// charted leg (the HG÷GC ratio); GC=F is the scorer's second input. Own price feed
// (fetchDailyCloses — =F futures have no free source: prices.ts),
// NOT the FRED loop, so NOT in INDICATORS; and NOT in PRICE_SCORERS (it has a bespoke
// two-symbol degrade-safe fetch, like R6/MOVE and R7).
export const CG: Indicator = withMultipliedThresholds({
  id: "CG",
  backfill: { years: EXPANDING_PERCENTILE_PREFIX_YEARS }, // depth OWNED by the constant's cited plan, reproduced here
  label: "Copper/Gold",
  longLabel: "Copper/gold ratio",
  series: "HG=F", // primary/charted = HG÷GC ratio; GC=F is the scorer's second input
  channel: "CONTEXT",
  confirmer: true,
  thresholds: {}, // bespoke two-leg ratio scorer (scoreRatioSpread + CG_DESCRIPTOR), not classify()
  unit: "",
  // 20d ratio return; negative bands (a DROP is the signal), mirroring F4's negative
  // return band. Chart-only descriptor for the chart's SECONDARY axis — verify
  // classifyDerived draws negative bands (F4 precedent says yes); scoring runs off
  // CG_DESCRIPTOR regardless, over BOTH legs. The level leg's moving cuts draw on the
  // PRIMARY axis from POINT_BAND_CUTS_OF.CG, never from here (Stage-6 follow-up).
  derived: {
    kind: "return",
    window: VELOCITY_WINDOW,
    amber: CG_AMBER_RET,
    red: CG_RED_RET,
    label: "20d ratio return",
    unit: "%",
  },
});

// --- VT VIX term-structure backwardation (T1.2, 2026-07-04) -----------------
//
// PROMOTED to COINCIDENT 2026-07-04 — Phase-2 sweep VALIDATED (+290d lead, C6 pbo=0.460 PASS,
// report.md §"Phase-2 candidate adjudication"). The VIX/VIX3M curve inverting into
// backwardation (near-term vol above 3-month = ratio > 1) is the real panic tell; spot VIX
// alone (R5) is coincident-and-late. Scored bespoke by scoreVixTermIndicator (confirmers.ts) off the
// ratio LEVEL, NOT classify() (hence thresholds:{}).
//
// Channel COINCIDENT: VT's confirmed `.state` joins maxState(byChannel("COINCIDENT")) (ladder.ts)
// beside R5/R6. A confirmed RED feeds the escalate-only coincident flag (cross-channel CRITICAL
// red-count + D1 de-escalation hold; the threshold-lowering COINCIDENT red-modifier was dropped
// 2026-07-15, O2 step 2) — VT can raise/confirm severity but never solo-trips;
// VT-AMBER is inert on that flag (it gates on RED only). Bands (VT_AMBER_RATIO/
// VT_RED_RATIO, derived off VT_DESCRIPTOR in family-descriptor-rows.ts — the single source, hand-retuned
// off the sweep-validated pair 2026-07-29). `series:"VIXCLS"` names the
// feed leg to fetch (numerator); VXVCLS is
// the scorer's second input — but what the detail chart PLOTS is the stored reading `value`,
// which is the scored VIX/VIX3M RATIO (run-seeds.ts `toStoredReading` stores `value: r.level`, and VT's level is the
// ratio), NOT VIX spot. So the ratio (~0.9–1.1) and its bands share one scale: the
// chart draws a display-only band overlay baked into the chart spec (N2), kept OFF `thresholds`
// so VT isn't flipped onto /api/series' per-mode recompute path (a `hasBands` bespoke indicator
// would there be re-scored by the generic scorer into a wrong ribbon). NO `derived` (the ratio
// needs BOTH legs, irreducible to a single-series transform of VIXCLS — same as R7). Own two-series
// degrade-safe feed: VIXCLS + VXVCLS via vix_term.ts (repointed off the dead closes provider
// `^`-index path 2026-07-26, IS-6 rung A — front and back now share R5's publication calendar),
// via `fetchVixTermLegs`, NOT the INDICATORS loop, so NOT in INDICATORS nor in
// PRICE_SCORERS (bespoke two-series fetch, like R6/R7/CG).
export const VT: Indicator = withMultipliedThresholds({
  id: "VT",
  // Same-day estimate (the VIX3M nowcast-error pass
  // covers both closes-provider legs, so VT leaves the Stage 6 carry roster for an estimator the notify dial folds): each FRED leg carried over its live `^VIX`/`^VIX3M` lead at beta 1 (R5's form;
  // the leads are the same instruments — checked 2026-10-19 over 60 sessions: |Δ| < 1e-6 on both legs) and the ratio scorer runs
  // unchanged over the extended legs — `vixEstimatePoints`, run-cycle-confirmers.ts.
  estimator: { kind: "leg-ratio", leads: ["^VIX", "^VIX3M"] },
  backfill: { years: EUFIN_BACKFILL_YEARS }, // EU-Fin top-8 seat
  label: "VIX/VIX3M",
  longLabel: "VIX term structure",
  series: "VIXCLS", // primary/charted = VIX÷VIX3M ratio numerator; VXVCLS is the scorer's second input
  channel: "COINCIDENT",
  thresholds: {}, // bespoke ratio-level scorer (scoreRatioSpread + VT_DESCRIPTOR), not classify()
  unit: "",
});

// --- VTP VIX backwardation PERSISTENCE leg (R3, EW-11/12/13, 2026-07-21) ----
//
// A DISTINCT scored leg over VT's SHARED VIXCLS/VXVCLS legs: the count of
// CONSECUTIVE most-recent days in BACKWARDATION (ratio > 1.00). VT's own ratio-LEVEL cuts stay
// byte-unchanged; this is a separate persistence read scored off the STREAK, not the level
// (scoreVixTermPersistence, scorers-composite.ts — hence `thresholds: {}`, no classify()).
//
// ⚠ `series: "^VIX"` is a DISPLAY/label declaration that predates the FRED repoint — the leg's data
// comes from VIXCLS/VXVCLS, not from a `^`-symbol price feed. It briefly also carried a dial
// effect (the `^`-prefix index-feed liveness guard forced a lagging VTP reading RED in the live
// array); that guard is retired, so what is left is purely a mislabel on screen. Repointing the
// field to `"VIXCLS"` is the open follow-up, not a no-op.
//
// NOTIFY-EXCLUDED (EW-13, half-overturned 2026-07-31) — this identity is DELIBERATELY absent from
// `INDICATORS`, `ALL_INDICATORS`, EVERY dial family (`families.ts`) and every roll-up.
// `channel: "CONTEXT"` is excluded from every roll-up and can never move the alert
// level (domain-types.ts §channel), and it joins no dial family either.
//
// It IS persisted and charted since 2026-07-31 (option B,
// user-ruled): `scoreVixTermPersistenceIndicator` is the TAIL entry of `FAST_CONFIRMERS`
// (confirmers.ts), so the reading lands in `readings[]` and in stored history. The
// persistence-exclusion half of EW-13 is dead; the notify/dial-family half stands.
//
// FALSIFIER for the surviving exclusion (the golden key sets derive from `ALL_INDICATORS`, so they
// are silent about persistence — do NOT re-derive an exclusion claim from them):
// `grep -rn VTP src/families.ts src/t1dial.ts` must stay empty, and the band invariant is pinned
// executably in `vix-term-persistence.test.ts` ("a RED VTP reading never moves the notify band").
// The notify BODY is a SEPARATE mechanism from the band's three structural reasons — it renders
// every non-GREEN reading in `readings[]`, so B.3 added the `CHART_ONLY_IDS` filter in
// `buildNotification` (notify_format.ts) and pinned it in the same suite.
// The PERSISTENCE side has its own executable pin — `confirmers.test.ts` asserts a full
// `runScoringCycle` emits a VTP reading; a grep can no longer stand in for either.
//
// Lives here (not in scorers-composite.ts)
// because identities are the registry's job; `scoreVixTermPersistence` takes it as its first
// parameter — the signature every other bespoke scorer already has — since scorers-*.ts must not
// import the registry (acyclic DAG registry → scorers → domain).
export const VTP: Indicator = {
  id: "VTP",
  label: "VIX backwardation",
  longLabel: "VIX backwardation streak",
  series: "^VIX",
  channel: "CONTEXT",
  thresholds: {},
  unit: "",
};

/**
 * CHART-ONLY identities: persisted into `readings[]` and served as history, yet deliberately
 * ABSENT from `ALL_INDICATORS` — so they stay out of `ID_SETS`, the goldens' key sets, the dial
 * families and every roll-up. This is the exact shape option B
 * rules for VTP: chartable, never notify-reaching.
 *
 * The INVARIANT membership grants (stated as a contract, not as a consumer list — the list grew from
 * one to several inside the shipping range and would rot again): an id here GAINS a served metadata
 * entry, so the readings store's label/unit are reconstructable (`/api/series?id=<id>` no longer 400s,
 * `/status` and `/api/indicators` label the row) — and GAINS the notify-body exclusion, so it never
 * prints a driver line or a lagging-leg name in a push. It NEVER scores, weights or bands: the
 * notify-exclusion reasons listed in the VTP block above are structural and untouched by membership.
 *
 * ⚠ **VTP is PERSISTED and CHARTED but still notify-excluded.** `CHART_ONLY_INDICATORS`/`CHART_ONLY_IDS`
 * (`src/registry.ts`) is the seam, and **both** body inputs must stay filtered: the driver lines
 * (`notify_format.ts` `visibleDrivers`) AND the lagging-leg list `opts.verdictHoldLegs`
 * (`notify_format.ts` `visibleVerdictHoldLegs`). ⚠ This named `opts.staleLegs` until 2026-08-08 — that
 * symbol died in the 2026-08-06 lag-terminology unification and survived only in this comment, so a
 * `grep staleLegs src/` found nothing but the claim itself.
 * `CARD_ONLY_GROUPS` gives it a card without a family seat — `familyOf("VTP")` stays
 * undefined. "Confirmer-only" is RETIRED repo-wide; it means chart-only.
 */
// --- HCX + FDX chart-only AVGO idiosyncratic leading legs (Stage 1) ---------------------------------
//
// Two CHART-ONLY composites on the existing price feed, sharing VTP's exact contract:
// persisted + charted on /lab, ABSENT from ALL_INDICATORS / every *_FAMILIES table / every
// roll-up, so neither can move the notify band or the T1 dial. `channel: "CONTEXT"`,
// `thresholds: {}` (bespoke scorers, not classify()). Scored + persisted off run-cycle-feeds.ts's
// GLOBAL_FEEDS (`target: "global"`), which spreads into `globalReadings` — persisted but
// kept out of the notify-facing `readings` array. Cuts are `[USER]`-owed [OPEN] priors carried
// on HCX_BAND / FDX_DESCRIPTOR (family-descriptor-rows.ts), hand-set in Stage 2 off the detail chart.
// `series` names the charted/primary leg. FAMILY_OF tags both `price-derived`.
export const HCX: Indicator = {
  id: "HCX",
  label: "Hyperscaler capex basket",
  longLabel: "Hyperscaler capex basket (GOOGL·META·MSFT·AMZN ÷ SPY, % from 12-mo high)",
  series: "GOOGL",
  backfill: { years: SEMIS_BACKFILL_YEARS }, // Semis top-10 seat
  channel: "CONTEXT",
  thresholds: {},
  unit: "",
  // Persisted `decision` + the derivedChart route (its perPoint breadth cuts): the LOW twin's
  // highDist line, mirror of F5/SPCONC. amber/red null — the drawn band is per-point (bandCuts).
  derived: {
    kind: "highDist",
    window: HIGH_WINDOW,
    amber: null,
    red: null,
    label: "capex basket / SPY % from 12-mo high",
    unit: "%",
  },
};
export const FDX: Indicator = {
  id: "FDX",
  label: "TSM/SMH foundry dependency",
  longLabel: "TSMC foundry-dependency ratio (TSM ÷ SMH, % vs MA50)",
  series: "TSM",
  channel: "CONTEXT",
  thresholds: {},
  unit: "",
  // Persisted `decision` + the derivedChart route (ms50 line + its cut pair, d20 second leg via
  // SECOND_LEG_CHART_OF): the ms50 %-vs-MA50 leg, mirror of F13. Every number off FDX_DESCRIPTOR.
  derived: {
    kind: "maSpread",
    window: FDX_DESCRIPTOR.scorer.constants.maWindow,
    amber: FDX_DESCRIPTOR.scorer.constants.amber,
    red: FDX_DESCRIPTOR.scorer.constants.red,
    label: "TSM/SMH vs MA50",
    unit: "%",
  },
};

/**
 * FETCH DEPTH for HCX — the basket index is WINDOW-RELATIVE, so every caller must fetch at FULL
 * feed depth (2026-08-29, off a reported chart cliff).
 *
 * `hcxBasketSeries` compounds `I_0 = 1` at the FIRST ALIGNED DAY of whatever closes it is handed,
 * so the persisted `value` (basket ÷ SPY) carries its fetch window's own base. A 2y window and a
 * 20y window disagree by all the compounding in between — measured on the live feed 2026-08-29,
 * same last date: idx 1.5096 (shallow `range=2y`) vs 26.795 (deep), 17.75×. That is NOT cosmetic,
 * because `api/series.ts` re-derives the plotted distance-from-high ACROSS STORED ROWS
 * (`BREADTH_DIST_BANDCUT_IDS`): two bases inside one 12-mo window print a cliff. Prod did exactly
 * that — the cron's shallow rows met the backfill's deep ones and the served dist stepped
 * −0.116 → −0.960 between 2026-08-21 and 2026-08-24 while the stored `decision` walked through
 * smoothly. A ROLLING deep window is just as wrong, only slower: its base drifts by the returns it
 * drops off the front every run.
 *
 * `{ deep: true }` (`DEEP_LOOKBACK_DAYS`, 20y) predates every constituent, so the inner join's left
 * edge is the FEED's own — META's 2012-05-18 IPO, a fixed calendar date — and every run anchors
 * identically. BOTH call sites fetch through this constant: `run-cycle-feeds.ts`'s GLOBAL_FEEDS row, and
 * `scripts/backfill.ts`'s HCX spec, which must IGNORE its plan window (the cooldown carriers'
 * `fullHistory` precedent) — a `since` plan re-bases the tail rows its re-shadow writes back.
 * `src/hcx-fetch-depth.test.ts` pins both sites; FDX needs none (TSM ÷ SMH is already scale-free).
 */
export const HCX_FETCH_OPTS = { deep: true } as const;

// --- EURC euro-curve inversion (slice 1b Stage 2) ---------------------------
//
// The euro AAA spot-curve slope SR_10Y − SR_3M (ECB, keyless SDMX-CSV via ecb.ts) —
// the euro-area sibling of US R1's term spread. `channel: "GLOBAL"` (slice 1b's
// dedicated isolated channel): GLOBAL is off every roll-up; the dial/families (GLOBAL_FAMILIES) read these ids
// — excluded from the alert + notify body for free
// (run-cycle-dial.ts also filters GLOBAL out of the notify-facing readings; /status excludes it
// beside the off-ladder track ids). It feeds ONLY the T1 dial's Rates family via
// GLOBAL_FAMILIES (worst-of alongside US T10Y3M). Scored bespoke by scoreEuroCurve
// (scorers-composite.ts) off the 2-tenor spread LEVEL, NOT classify() (hence thresholds:{}),
// and NO `derived` (irreducible to a single-series transform, same as R7/VT). Its
// own keyless ECB feed (fetchEcbSeries), NOT the FRED loop → NOT in INDICATORS, and
// NOT in PRICE_SCORERS/FAST_CONFIRMERS/TRACKS. `series:"SR_10Y"` names the primary/
// charted tenor; SR_3M is the scorer's second input. Bands EURC_AMBER/EURC_RED
// (derived off EURC_DESCRIPTOR in family-descriptor-rows.ts) are coarse [OPEN] priors,
// re-derived at build.
export const EURC: Indicator = withMultipliedThresholds({
  id: "EURC",
  // Depth = the shared default: the backfill asks ECB by `startPeriod`; the ~60-obs window is the cron's call only.
  label: "Euro 10y−3m",
  longLabel: "Euro curve 10y−3m (ECB AAA)",
  series: "SR_10Y", // primary/charted tenor; SR_3M is the scorer's second input
  // ECB, Frankfurt — a European publisher, so its age is judged on Berlin's calendar, not the
  // US-Central default (`FEED_CALENDAR_TZ`).
  feedTimeZone: "Europe/Berlin",
  channel: "GLOBAL",
  thresholds: {}, // bespoke 2-tenor spread-level scorer (scoreRatioSpread + EURC_DESCRIPTOR), not classify()
  unit: "",
});

// --- ESTR overnight rate (2026-09-24, eufin-exsh-top5 N3) ----------------
//
// Keyless ECB feed (ecb.ts `ESTR`, dataflow EST), T+1 ~08:00 CET — the daily slot tier covers it.
// `channel: "GLOBAL"` — NEVER "RATE" (rate escalator) nor BAND_DRIVING.
// Window + cuts are DESCRIPTOR-resident (ESTR_DESCRIPTOR): a quarter, not VELOCITY_WINDOW — the ECB's
// 6-week meeting cadence makes a 20-day Δ a one-meeting read (measured: red 0d over 2019–2026).
export const ESTR: Indicator = withMultipliedThresholds({
  id: "ESTR",
  label: "ESTR Δ",
  longLabel: "ESTR overnight rate velocity",
  series: "ESTR",
  feedTimeZone: "Europe/Berlin",
  cadence: "daily",
  channel: "GLOBAL",
  thresholds: {}, // sole rule is `derived` below (scoreDerived) — generic velocity legs are HIGH-only
  backfill: { years: ESTR_BACKFILL_YEARS },
  unit: "%",
  derived: {
    kind: "change",
    window: ESTR_DESCRIPTOR.scorer.constants.window,
    amber: ESTR_DESCRIPTOR.scorer.constants.amber,
    red: ESTR_DESCRIPTOR.scorer.constants.red,
    label: `${ESTR_DESCRIPTOR.scorer.constants.window}-day Δ (pp)`,
    unit: "",
  },
});

// EPATH euro policy path SR_1Y − ESTR (ECB `YC` + `EST`), scored + persisted as the EPATH_DESCRIPTOR mean.
// Context-only (no MEMBER_WEIGHT/TIMING_CLASS row — the ECISS/EURGBP precedent).
// Depth = the shared default: the backfill asks ECB by `startPeriod`, so the cron's ~60-obs window does not bound it.
export const EPATH: Indicator = withMultipliedThresholds({
  id: "EPATH",
  label: "Euro 1y−ESTR",
  longLabel: "Euro policy path 1y − ESTR (ECB AAA)",
  series: "SR_1Y", // primary/charted tenor; ESTR is the scorer's second input
  feedTimeZone: "Europe/Berlin",
  channel: "GLOBAL",
  thresholds: {}, // spread-level scorer (scoreRatioSpread + EPATH_DESCRIPTOR), not classify()
  unit: "",
});

// --- ECISS ECB composite CISS, euro area (2026-09-24, eufin-exsh-top5 C-block) ------
//
// Keyless ECB feed (ecb.ts `ECISS`, dataflow CISS), daily obs released WEEKLY ⇒ `lagAfterDays: 8`.
// `channel: "CONTEXT"`, rowless (ruling Q4): display-only, no family seat, off the dial and notify.
export const ECISS: Indicator = withMultipliedThresholds({
  id: "ECISS",
  label: "CISS",
  longLabel: "CISS composite systemic stress (euro area)",
  series: "ECISS",
  feedTimeZone: "Europe/Berlin",
  cadence: "daily",
  lagAfterDays: 8,
  channel: "CONTEXT",
  thresholds: { ...ECISS_DESCRIPTOR.thresholds },
  backfill: { years: ECISS_BACKFILL_YEARS },
  unit: "",
});

// --- EURGBP sterling vs euro, ECB reference rate (2026-09-25, eurgbp seat-10) ------------------
//
// Keyless ECB feed (ecb.ts `EURGBP`, dataflow EXR). Rising = danger; scored by `scoreReturnOrMaSpread`
// (worst-of 20d move OR vs-MA50). `channel: "CONTEXT"`, rowless: display-only, off the dial and notify.
const EURGBP_RET = EURGBP_DESCRIPTOR.scorer.constants;
export const EURGBP: Indicator = withMultipliedThresholds({
  id: "EURGBP",
  label: "EUR/GBP",
  longLabel: "Sterling vs euro (EUR/GBP)",
  series: "EURGBP",
  feedTimeZone: "Europe/Berlin",
  cadence: "daily",
  channel: "CONTEXT",
  thresholds: {},
  backfill: { years: EURGBP_BACKFILL_YEARS },
  unit: "",
  derived: {
    kind: "return",
    window: VELOCITY_WINDOW,
    amber: EURGBP_RET.retAmber,
    red: EURGBP_RET.retRed,
    label: `${VELOCITY_WINDOW}-day move`,
    unit: "%",
  },
});

// --- BUND Bund curve 10y−2y (rung 3) ----------------------------------------
//
// The German Bund curve slope 10y − 2y: sovereign-quote `DE10Y-DE` − `DE2Y-DE` (keyless), the BONOS clock.
// EURC's 10y−3m is anchored to the CURRENT policy rate; 10y−2y is anchored to the
// EXPECTED policy path, so the two diverge hardest at a pivot — the same distinction the
// US side already honours between R1 (T10Y3M) and R7 (the bull-steepener), each with its
// own MEMBER_WEIGHT row. Its family seat was MEASURED, not argued.
// provenance: docs/indicator-cut-provenance.md §BUND
//
// Wiring mirrors EURC: `channel: "GLOBAL"` (off every roll-up, dial-only), NOT classify() (hence
// thresholds:{}), and NO `derived` (needs BOTH tenors, irreducible to a single-series
// transform). Scored bespoke by `scoreCurve` — worst-of Δ20 slope velocity, the inversion LEVEL
// single-cut at AMBER (BUND_AMBER; BUND_RED is context-only), and the 2y re-steepening escalation;
// every knob on BUND_DESCRIPTOR. Own sovereign-quote legs → NOT in INDICATORS, and NOT in
// PRICE_SCORERS/FAST_CONFIRMERS/TRACKS. `series:"DE10Y"` names the primary/charted tenor; DE2Y is the
// scorer's second input.
export const BUND: Indicator = withMultipliedThresholds({
  id: "BUND",
  // EU-Fin top-8 seat — a years-deep ask by `[USER]` ruling (2026-09-24), deeper than the shared default.
  backfill: { years: EUFIN_BACKFILL_YEARS },
  label: "Bund 10y−2y",
  longLabel: "Bund curve 10y−2y",
  series: "DE10Y", // primary/charted tenor (sovereign-quote `DE10Y-DE`); DE2Y is the scorer's second input
  // German Bund market close, Frankfurt — European calendar.
  feedTimeZone: "Europe/Berlin",
  // Business-daily release. Registered EXPLICITLY (RULED 2026-08-08) so `isExplicitlyRegistered`
  // is true and the deep-lag bar floors at the daily tier — `2 × max(p90Gap, LAG_THRESHOLDS.daily)`
  // rather than `2 × p90Gap`, closing the window between the FRESH cut and a bar of 6. Accepted
  // side effect: an explicit registration silences `shouldCorrect` advice for this id (feed-lag.ts).
  cadence: "daily",
  channel: "GLOBAL",
  thresholds: {}, // bespoke 3-leg curve scorer (scoreCurve + BUND_DESCRIPTOR), not classify()
  unit: "",
});

// --- VXNCLS Nasdaq-100 vol (chart-only, 2026-10-18): level, generic scoreIndicator — `thresholds: {}` ⇒ GREEN always ---
export const VXNCLS: Indicator = {
  id: "VXNCLS",
  label: "VXN",
  longLabel: "Nasdaq-100 volatility (VXNCLS)",
  series: "VXNCLS",
  channel: "CONTEXT",
  thresholds: {},
  unit: "",
  estimator: { kind: "carry-mult", leads: ["^VIX"], beta: 1 },
};

/** Bespoke `scoreVxnTerm` + `VXNT_DESCRIPTOR`; display-only;
 *  provenance §VXNT (indicator-cut-provenance.md). */
export const VXNT: Indicator = {
  id: "VXNT",
  label: "VXN/VIX3M adj",
  longLabel: "VXN term structure: VXNCLS ÷ (VXVCLS × k), k = 250-close median VXNCLS/VIXCLS",
  series: "VXNCLS",
  channel: "CONTEXT",
  thresholds: {},
  unit: "",
  // VT's lane: the VIX legs carried over `^VIX`/`^VIX3M`, the VXN leg over VXNCLS's own `carry-mult` (`vixEstimatePoints`).
  estimator: { kind: "leg-ratio", leads: ["^VIX", "^VIX3M"] },
};

// --- T10Y3M_RAW daily 10y−3m (chart-only, 2026-10-18): R1's FRED series UNsmoothed (R1 serves the 21-close mean); id ≠ the `T10Y3M` input-series row ---
export const T10Y3M_RAW: Indicator = {
  id: "T10Y3M_RAW",
  label: "10y−3m raw",
  longLabel: "Term spread 10y-3m, daily (FRED T10Y3M)",
  series: "T10Y3M",
  channel: "CONTEXT",
  thresholds: {}, // unit omitted ⇒ "%", as R1
};

// --- VXSMH semis-ETF vol (chart-only, 2026-10-24): index-only CSV (`INDEX_ONLY_SYMBOL_OF`), from 2025-09-16 ---
// No estimator: a `carry-mult` off ^VIX would paint the semis-only dips this series exists to show as broad-vol moves.
export const VXSMH: Indicator = {
  id: "VXSMH",
  label: "VXSMH",
  longLabel: "Semiconductor ETF volatility (VXSMH)",
  series: "VXSMH",
  channel: "CONTEXT",
  thresholds: {},
  unit: "",
};

export const CHART_ONLY_INDICATORS: readonly Indicator[] = [VTP, HCX, FDX, VXNCLS, VXNT, T10Y3M_RAW, VXSMH];
/** The `CHART_ONLY_INDICATORS` ids — the id-keyed half of the same invariant (seed coverage in
 *  `scripts/backfill.ts specs()`, the notify-body + lagging-leg exclusion in `notify_format.ts`, the
 *  `chartOnly` flag on the served `/api/indicators` union). */
export const CHART_ONLY_IDS: readonly string[] = CHART_ONLY_INDICATORS.map((i) => i.id);

// --- CQS corporate quality spread, Baa−Aaa (2026-08-06 `[USER]`) -------------
//
// The CARD that REPLACED the BAA10Y card.
// The BAA10Y INDICATOR retired fully 2026-08-11: the FRED `BAA10Y` series is now purely a CQS
// input (its stored rows remain in the DB, unserved).
//
// WHAT IT IS: FRED `BAA10Y` − FRED `AAA10Y`, both daily and keyless, inner-joined by date. Each leg
// is already Treasury-differenced, so the 10y term cancels and the difference is the pure
// investment-grade QUALITY LADDER — the price of stepping from the top IG rung to the bottom one —
// with the duration/level component of a raw Baa spread removed. WIDENING is the danger (direction
// HIGH), which is why it is scored bespoke (`scoreCreditBridge` — the EBP-bridge Δ/z,
// scorers-composite.ts) rather than through the ratio/spread stack, whose `cutKind: "spread"` fires LOW.
//
// LEAD/COIN: "lead" — lead-by-LATENCY, not by content — a nowcast bridge over EBP's lag window;
// the content class is `coin` (a realized spread level).
//
// `channel: "CONTEXT"` — off the FIN roll-up and the notify path, but SEATED in `GLOBAL_FAMILIES.credit`
// since Stage 3.1, so it moves the credit leg RAG via its `MEMBER_WEIGHT` row (the F13/F10 treatment).
// It is deliberately ABSENT from `CALIB_MAP` (its cuts are hand-set, so there is no vintage to
// resolve). `series` names the FIRST input only (the F13 precedent); `AAA10Y` is the scorer's
// second input and is fetched beside it in run-cycle-fred.ts. `thresholds: {}` is the VT/GB precedent —
// the bands come from `CQS_DESCRIPTOR`, not from `classify()`.
export const CQS: Indicator = withMultipliedThresholds({
  id: "CQS",
  label: "Baa−Aaa",
  longLabel: "Corporate quality spread (Baa−Aaa)",
  series: "BAA10Y", // primary/charted leg; AAA10Y is the scorer's second input
  channel: "CONTEXT",
  thresholds: {}, // bespoke EBP-bridge scorer (scoreCreditBridge + CQS_DESCRIPTOR), not classify()
  unit: "",
});

// --- BONOS Spanish−German 10y sovereign spread (2026-09-24, contagion S1) ----
export const BONOS: Indicator = withMultipliedThresholds({
  id: "BONOS",
  backfill: { years: BONOS_BACKFILL_YEARS },
  label: "Bonos−Bund 10y",
  longLabel: "Spanish−German 10y sovereign spread",
  series: "ES10Y", // sovereign-quote `ES10Y-ES`; DE10Y is the scorer's second input
  feedTimeZone: "Europe/Madrid",
  channel: "GLOBAL",
  // Spain's OWN absolute bp pair — hand-set [USER] 2026-09-24 (contagion S2).
  thresholds: { amberLevel: 60, redLevel: 70 },
  unit: "bp",
});

// --- FXH FX-haven composite (slice 1b Stage 4) ------------------------------
//
// The flight-to-safety FX axis — a worst-of 20d "haven-bid" move over three keyless daily
// the closes feed's FX pairs (EURUSD=X, CHF=X, JPY=X — same quote directions as the retired FRED H.10
// trio DEXUSEU/DEXSZUS/DEXJPUS), scored bespoke by scoreFxHaven (scorers-composite.ts;
// see its block header for the load-bearing per-series polarity). `channel: "GLOBAL"`
// (slice 1b's isolated channel): GLOBAL is off every roll-up; the dial/families (GLOBAL_FAMILIES) read these ids
// COINCIDENT/GEO, so GLOBAL is excluded from the verdict + notify body for free (run-cycle-dial.ts
// keeps it out of the notify-facing `readings`; /status filters GLOBAL beside the
// off-ladder ids). It feeds ONLY the T1 dial's Flight family via GLOBAL_FAMILIES
// (re-points ["CG"]→["FXH"]). Its own prices fetches (×3), NOT the FRED verdict loop → NOT
// in INDICATORS, and NOT in PRICE_SCORERS/FAST_CONFIRMERS/TRACKS. `series:"EURUSD=X"`
// names the primary/charted leg; CHF=X/JPY=X are the scorer's other two inputs. NO
// `derived` (irreducible to a single-series transform, like R7/VT/EURC). Bands
// FXH_AMBER/FXH_RED (derived off FXH_DESCRIPTOR in family-descriptor-rows.ts) are hand-set
// (retuned 2026-09-04; provenance in `docs/indicator-cut-provenance.md` §FXH). Do NOT
// reuse the `DEXUSEU` id — PENSION owns it; the composite reading id is `FXH`.
export const FXH: Indicator = withMultipliedThresholds({
  id: "FXH",
  label: "Haven FX",
  longLabel: "FX havens (EUR/CHF/JPY bid)",
  series: "EURUSD=X", // primary/charted leg; CHF=X/JPY=X are the scorer's other inputs
  channel: "GLOBAL",
  // Keep `cadence` explicit: it preserves `isExplicitlyRegistered` (feed-lag.ts §Stage 4 fork).
  cadence: "daily",
  thresholds: {}, // bespoke worst-of-3 haven-bid scorer (scoreFxHaven), not classify()
  unit: "",
});

// --- GT global trend + GB global breadth (slice 1b Stage 5) -----------------
//
// The Trend family re-point: from the US-tech proxy (F4/F5/NVDA) onto a GLOBAL trend
// read. GT = ACWI (all-country world) vs its own MA200; GB = breadth participation
// across seven region/style ETFs (SPY/VGK/EWJ/VWO/XLP/XLV/VYM). F4/F5/NVDA STAY in
// ALL_INDICATORS (still scored via PRICE_SCORERS, still the slow track + veto panel) —
// only the dial's trend family MEMBERSHIP re-points (GLOBAL_FAMILIES trend ["F4","F5",
// "NVDA"]→["GT","GB"]). Both `channel:"GLOBAL"` (off every roll-up; the dial/families
// (GLOBAL_FAMILIES) read these ids — and the dial IS the notify band),
// fed via fetchDailyCloses (prices.ts), NOT the FRED loop →
// NOT in INDICATORS, and NOT in PRICE_SCORERS/FAST_CONFIRMERS/TRACKS.
//
// GT is scored bespoke by scoreGlobalTrend off the `maSpread` decision variable (the
// NVDA-gate machinery) — so it CARRIES a `derived` descriptor for the detail chart, and
// that descriptor's amber/red ARE the scoring bands (GT_AMBER/GT_RED, derived off
// GT_DESCRIPTOR in family-descriptor-rows.ts). Unlike
// the capped NVDA gate (red:null), GT is the real leading global-trend leg → a REAL red
// band, so it can go RED. `thresholds:{}` (bands live on `derived`, not classify()).
export const GT: Indicator = withMultipliedThresholds({
  id: "GT",
  backfill: { years: EUFIN_BACKFILL_YEARS }, // EU-Fin top-8 seat
  label: "ACWI trend",
  longLabel: "Global trend (ACWI vs MA200)",
  series: "ACWI",
  channel: "GLOBAL",
  thresholds: {}, // bespoke maSpread scorer (scoreGlobalTrend); bands ride `derived` below
  unit: "",
  // % distance from MA200 (maSpread). Both bands real (RED-capable), unlike NVDA's red:null.
  derived: {
    kind: "maSpread",
    window: MA_WINDOW,
    amber: GT_AMBER,
    red: GT_RED,
    label: "% vs MA200",
    unit: "%",
  },
});

// GB is a COMPOSITE (participation % across seven ETFs' own-MA200 checks), irreducible to
// a single-series transform → NO `derived` (like R7/VT/EURC/FXH) and `thresholds:{}` (its
// GB_AMBER/GB_RED bands are derived off GB_DESCRIPTOR in family-descriptor-rows.ts and applied by
// scoreGlobalBreadth). `series:"SPY"` names the primary/
// representative constituent (the composite's stored `level` is the participation
// fraction, not a single price); the other six ETFs are scorer inputs only.
export const GB: Indicator = withMultipliedThresholds({
  id: "GB",
  label: "Global breadth",
  longLabel: "Global breadth (7 ETFs vs MA200)",
  series: "SPY", // primary/representative constituent; the other six ETFs are scorer inputs
  channel: "GLOBAL",
  thresholds: {}, // bespoke composite participation scorer (scoreGlobalBreadth), not classify()
  unit: "",
});

// --- DISP global dispersion (slice 1b Stage 6) ------------------------------
//
// The "systemic vs isolated" read over three USD regional proxies — SPY (US), FEZ
// (Europe), EEM (EM): are they falling TOGETHER (broad/systemic stress) or is one
// region down while the others hold (isolated)? Scored bespoke by scoreDispersion
// (scorers-composite.ts) — the rolling 20d MEAN PAIRWISE return-correlation gated by a
// NEGATIVE 20d basket return; correlation+negative-basket is the pinned metric
// (NOT return-dispersion). `channel:"GLOBAL"`
// (off every roll-up; the dial/families
// (GLOBAL_FAMILIES) read this id — and the dial IS the notify band);
// it feeds ONLY the T1 dial's Dispersion family via GLOBAL_FAMILIES (["DISP"], was the
// empty no-feed stub). Its own price fetches (SPY reused, FEZ/EEM new via
// fetchDailyCloses), NOT the FRED loop → NOT in INDICATORS/PRICE_SCORERS/FAST_
// CONFIRMERS/TRACKS. `series:"SPY"` names the primary/charted leg (the stored `level`
// is the mean pairwise corr, not a single price); FEZ/EEM are scorer inputs only. NO
// `derived` (a 3-series composite, irreducible to a single-series transform, like GB).
export const DISP: Indicator = withMultipliedThresholds({
  id: "DISP",
  label: "Global dispersion",
  longLabel: "Global dispersion (SPY·FEZ·EEM)",
  series: "SPY", // primary/representative leg; FEZ/EEM are scorer inputs only
  channel: "GLOBAL",
  thresholds: {}, // bespoke correlation+basket scorer (scoreDispersion), not classify()
  unit: "",
});

/** Declared inputs of every multi-input composite outside `RATIO_DESCRIPTOR_OF` (whose descriptors carry
 *  their own `inputs`) and PRICE_SCORERS / RS_LEGS (likewise) — the series its scorer combines into the
 *  served value, keyed by reading id. `src/licensed.ts` derives the licensed verdict from them; a gate
 *  that only moves the state (ECY's GT trend) is not an input. ECY's row lives in registry-fred.ts. */
export const COMPOSITE_INPUTS: Readonly<Record<string, readonly string[]>> = {
  VTP: ["VIXCLS", "VXVCLS"], // VT's shared legs (scoreVixTermPersistence)
  HCX: [...HCX_SYMBOLS, "SPY"], // capex basket ÷ SPY
  FDX: ["TSM", "SMH"],
  CQS: ["BAA10Y", "AAA10Y", "ebp"], // scoreCreditBridge
  BONOS: ["ES10Y", "DE10Y"],
  GB: [...GB_SYMBOLS],
  DISP: ["SPY", "FEZ", "EEM"],
  ECY: ["F7", "DFII10"], // scoreEcy: CAPE earnings yield − real 10y
};

// --- Composite-component vintage rows (audit rank 11) -----------------------
//
// GT/GB/DISP/FXH/EURC persist ONLY the derived composite; their raw component closes
// were fetched then discarded, so the day a free feed closes the composite becomes
// unreplayable forever (precedent: FRED's F1 clamp forced an Internet-Archive rescue).
// Persist each component's LATEST close per run as a DISPLAY-ONLY reading row — the
// DB_*/navReadingRow idiom: dedicated composite-SCOPED `CMP_<composite>_<symbol>` ids
// (so a symbol shared across composites — SPY in GB+DISP, EURUSD=X in FXH + the pension
// leg — never collides in one atomic run), `channel: "GLOBAL"`, `thresholds: {}`, NO
// scorer/`derived`. DELIBERATELY NOT in ALL_INDICATORS (exactly like DB_*): they never
// enter INDICATORS/PRICE_SCORERS/roll-ups, never need an INDICATOR_DESC entry, and every
// family/dial reduce excludes them by id OMISSION (never in a `*_FAMILIES.ids` whitelist).
// Captured ONLY on the cron path (run-cycle-feeds.ts, reusing the closes each composite already
// fetched — zero new feed); the /lab replay reads readings by family id, so it never
// surfaces them. Latest obs per run is enough: the daily cron accumulates vintages, and
// a backtest replays the composite from the accumulated CMP_ series.
function componentIndicator(
  parent: Indicator,
  id: string,
  symbol: string,
  cadence?: Cadence,
  lagAfterDays?: number,
): Indicator {
  return withMultipliedThresholds({
    id,
    label: `${parent.id} component - ${symbol} (raw close, display-only)`,
    // Debug series — never a tile or a push line, so short == long by design.
    longLabel: `${parent.id} component - ${symbol} (raw close, display-only)`,
    series: symbol,
    channel: "GLOBAL",
    thresholds: {},
    unit: "",
    // Inherit the composite's publish cadence so the display-only vintage row's per-feed lag
    // matches its parent (W4-e Stage 1: FXH's three H.10 legs are weekly, not the default daily).
    // Still per-spec rather than read off `parent` — the ruled pairs are pinned independently in
    // `registry.test.ts`'s RULED table, which is the second source that would drift if this
    // derived them.
    ...(cadence ? { cadence } : {}),
    ...(lagAfterDays === undefined ? {} : { lagAfterDays }),
    // The publication CALENDAR, by contrast, is derived from the parent and can never be typed
    // per spec: the component IS the parent's own feed (`componentBackfillSeries` maps the very closes
    // the composite fetched), so a component judged on a different calendar than its parent makes
    // /lab's freshness board self-inconsistent — on a frozen ECB feed in the CEST evening window
    // the parent reads a day older than the component it was computed from. `undefined` on a
    // US-published parent leaves the component on the `FEED_CALENDAR_TZ` default, unchanged.
    ...(parent.feedTimeZone === undefined ? {} : { feedTimeZone: parent.feedTimeZone }),
  });
}

interface ComponentSpec {
  // The composite's own registry row, not its id string — the component's label, its map key and
  // its publication calendar all come off this object, so a component can never name a composite
  // that does not exist nor drift from its parent's calendar.
  parent: Indicator;
  symbol: string;
  id: string;
  // Absent ⇒ default daily (LAG_THRESHOLDS). Set to match the composite's own cadence.
  cadence?: Cadence;
  // Absent ⇒ the cadence tier's cut. Set to match the composite's own per-source override.
  lagAfterDays?: number;
}
const COMPONENT_SPECS: ComponentSpec[] = [
  { parent: EURC, symbol: "SR_10Y", id: "CMP_EURC_SR10Y" },
  { parent: EURC, symbol: "SR_3M", id: "CMP_EURC_SR3M" },
  // BUND's two sovereign-quote legs; CMP_BUND_DE10Y is the sovereign-quote German vintage BONOS shares, stored ONCE, here.
  { parent: BUND, symbol: "DE10Y", id: "CMP_BUND_DE10Y" },
  { parent: BUND, symbol: "DE2Y", id: "CMP_BUND_DE2Y" },
  { parent: BONOS, symbol: "ES10Y", id: "CMP_BONOS_ES10Y" },
  // FXH's three closes-provider `=X` legs mirror FXH.cadence: daily. Store ids keep the historical FRED names —
  // store-id ≠ fetch-ticker, the PENSION `DEXUSEU`/`EURUSD=X` split — so the accrued CMP_ vintage
  // series stays one chain.
  { parent: FXH, symbol: "EURUSD=X", id: "CMP_FXH_DEXUSEU", cadence: "daily" },
  { parent: FXH, symbol: "CHF=X", id: "CMP_FXH_DEXSZUS", cadence: "daily" },
  { parent: FXH, symbol: "JPY=X", id: "CMP_FXH_DEXJPUS", cadence: "daily" },
  { parent: GT, symbol: "ACWI", id: "CMP_GT_ACWI" },
  ...GB_SYMBOLS.map((s) => ({ parent: GB, symbol: s, id: `CMP_GB_${s}` })),
  { parent: DISP, symbol: "SPY", id: "CMP_DISP_SPY" },
  { parent: DISP, symbol: "FEZ", id: "CMP_DISP_FEZ" },
  { parent: DISP, symbol: "EEM", id: "CMP_DISP_EEM" },
  // HCX basket legs + FDX foundry legs (Stage 1) — component closes are otherwise discarded, so
  // the chart-only composites stay replayable off their stored vintage rows.
  ...HCX_SYMBOLS.map((sym) => ({ parent: HCX, symbol: sym, id: `CMP_HCX_${sym}` })),
  { parent: FDX, symbol: "TSM", id: "CMP_FDX_TSM" },
  { parent: FDX, symbol: "SMH", id: "CMP_FDX_SMH" },
];

interface CompositeComponent {
  id: string;
  symbol: string;
  indicator: Indicator;
}

/**
 * Per-composite component metadata, keyed by the composite's reading id. run-cycle-feeds.ts iterates
 * the entry for each composite it scores, mapping the closes it ALREADY fetched
 * (`bySymbol`) to display-only vintage rows via `componentBackfillSeries`.
 */
export const COMPOSITE_COMPONENTS: Record<string, CompositeComponent[]> = {};
for (const s of COMPONENT_SPECS) {
  (COMPOSITE_COMPONENTS[s.parent.id] ??= []).push({
    id: s.id,
    symbol: s.symbol,
    indicator: componentIndicator(s.parent, s.id, s.symbol, s.cadence, s.lagAfterDays),
  });
}

// Dense per-day vintage series for one composite's components (EVERY close): run-cycle persists its
// `.at(-1)`, the gap-fill sweep and backfillHistory the rest — the stored CMP_ series is a daily calendar.
export function componentBackfillSeries(
  composite: string,
  bySymbol: Record<string, Observation[]>,
): { id: string; symbol: string; series: Reading[] }[] {
  const out: { id: string; symbol: string; series: Reading[] }[] = [];
  for (const c of COMPOSITE_COMPONENTS[composite] ?? []) {
    const obs = bySymbol[c.symbol] ?? [];
    if (obs.length === 0) continue;
    out.push({
      id: c.id,
      symbol: c.symbol,
      series: obs.map((o) => ({
        indicator: c.indicator,
        date: o.date,
        level: o.value,
        delta20: 0,
        rawState: "GREEN" as const,
        state: "GREEN" as const,
        decision: null,
      })),
    });
  }
  return out;
}
