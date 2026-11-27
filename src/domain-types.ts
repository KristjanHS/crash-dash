/**
 * Indicator domain — shared types + module constants (Stage 5c leaf 1 of 4).
 *
 * The DAG sink of the domain split: this file has **ZERO imports** and must keep
 * it that way. Edge order across the split is one-way,
 * `domain-fold` → `domain-legs` → `domain-cuts` → `domain-types`.
 *
 * Each indicator resolves to Green (0) / Amber (1) / Red (2) per
 * docs/bigtech-crash-dashboard-design-v4.md §4, then the confirmation fold
 * (v4 §6.1) is applied at the indicator's own tier. ⚠ DIRECTIONAL since 2026-08-26
 * (`asymConfirmedStateSeries`): a worse raw state confirms same-day, an improved
 * one stands down after the tier's clean closes (`CONFIRM_TIERS`, all 2 — the
 * DOWN buffer only; the LEG/position side keeps its own symmetric
 * `danger-engine.ts` CONFIRM_CLOSES = 2). Velocity thresholds are
 * still derived from the full FRED history each run — no persistence needed.
 */

export type State = "GREEN" | "AMBER" | "RED";

export const STATE_RANK: Record<State, number> = { GREEN: 0, AMBER: 1, RED: 2 };

/**
 * Which roll-up an indicator feeds (v4 §6.2):
 *  - FIN: financing channel (FIN_score)
 *  - RATE: leading-rate channel (RATE_score) — term spread + yield velocity
 *  - COINCIDENT: "fuse is lit" gauges (VIX/MOVE) — modifier only, never a
 *    standalone trigger.
 *  - CONTEXT: situational-awareness rows — off the FIN/RATE/COINCIDENT/GEO alert roll-up SCORES
 *    (no alert-channel score sums/maxes them). NOT off the T1 dial, though: most CONTEXT ids are
 *    seated danger-family members (GLOBAL_FAMILIES → DIAL_FAMILIES; e.g. F4/F5/F6/F8 in trend,
 *    CQS in credit), and since the dial band is the notify band's FLOOR, such a CONTEXT reading
 *    CAN raise the notify band via the dial (just not via the legacy roll-up).
 *    ⚠ Seating is NECESSARY, NOT SUFFICIENT: a member reaches the dial's rung/band only through a
 *    family in `LEADING` or `COINCIDENT` (`src/t1dial.ts`), and BOTH explicitly filter `valuation`
 *    out — `NO_ARM_FAMILIES` is exactly `{valuation}` today, and `positionP` carries no valuation
 *    term either (`mEff` retired, O2 2026-08-11). So `ECY` is seated in a dial family and STILL
 *    band-inert: its reach is the 9-leg danger RAG, not the notify band. "Display-only w.r.t. the
 *    band" therefore covers both the family-less ids (VTP, NVDA) AND valuation's members.
 *  - GEO: geopolitical channel (G1 oil shock + manual flags). Each elevated GEO
 *    reading counts as one geo flag (a COUNT, not a state-rank sum) — WATCH ≥1,
 *    WARNING ≥2, never CRITICAL alone (§6.4).
 *  - SLOW / PENSION: off-ladder display-only channels. Their readings persist in the
 *    same `readings` table (so /api/series can chart them) but NEVER enter
 *    any alert roll-up — no scorer/thresholds — and /api/status filters them out so they
 *    can't pollute the fast panel. PENSION carries the pension legs (SPY/VEA/SP500IT
 *    plus the DEXUSEU FX leg).
 *  - GLOBAL: the isolated channel for the T1-dial global feed set (slice 1b). Like
 *    SLOW/PENSION it is off the alert roll-up SCORES — excluded from the FIN/RATE/etc alert
 *    channels and the notify message BODY/census for free, and /api/status must filter it out of
 *    the fast panel. But it FEEDS the T1 dial (the dial/families read these ids via
 *    GLOBAL_FAMILIES → DIAL_FAMILIES), and the dial band is the notify band's FLOOR, so a GLOBAL
 *    reading CAN raise the notify BAND through the dial — it is NOT off the notify path (design §C1).
 */
export type Channel =
  | "FIN"
  | "RATE"
  | "COINCIDENT"
  | "CONTEXT"
  | "GEO"
  | "SLOW"
  | "PENSION"
  | "BOTTOM"
  // BREADTH: raw adjusted closes stored ONLY as the DB-first backing for the deep breadth fetch
  // (§6.2). Never in ALL_INDICATORS (no card, no
  // roll-up, no census), so this channel is never enumerated by any panel — it exists to keep the
  // BR_* store ids off every scored path structurally. NOT the PENSION/BOTTOM pattern: those legs ARE
  // in ALL_INDICATORS and are excluded from roll-ups by their CONTEXT treatment. BR_*'s exclusion is
  // absence from the registry itself, which is stricter.
  | "BREADTH"
  | "GLOBAL";

/**
 * Threshold polarity. HIGH = higher value is worse (credit spreads, yield
 * velocity, VIX). LOW = lower value is worse (the term spread R1, which is
 * worst when inverted/negative). Only the LEVEL comparison flips; velocity is
 * always "fast rise = worse" (HIGH), and R1 — the only LOW indicator — has no
 * velocity threshold, so this never bites the wrong way.
 */
export type Direction = "HIGH" | "LOW";

/**
 * Observation cadence — how often a feed publishes a fresh point. Drives the
 * `delta20` span label AND the per-cadence lag threshold (ladder.ts). A
 * WEEKLY feed (F3 NFCI Risk; the FRED H.10 FX rates behind FXH) is EXPECTED to
 * read a whole release cycle behind by weekday, so its lag cut sits well above
 * the daily tier — and both of those two ride even higher, on their own
 * `lagAfterDays`. Values live in `LAG_THRESHOLDS`, never here.
 */
export type Cadence = "daily" | "weekly" | "monthly" | "quarterly";

/** Trading-day lookback for the velocity thresholds. */
export const VELOCITY_WINDOW = 20;

/** Consecutive closes a raw state must hold before it counts (v4 §6.1, tunable). */
export const CONFIRM_CLOSES = 2;


// BAA10Y_* cut constants moved to family-descriptor-rows.ts (Stage 1.2) — the ONE source.

/**
 * How one indicator's OR-legs COMBINE at a severity tier — the per-indicator statement of the
 * FOLD, not of any cut.
 *
 * An ABSENT field (and an absent policy altogether) means `"or"`: any single leg firing raises
 * the tier, which is the shipped semantics for every indicator and the reason this type can be
 * introduced as a provable no-op. `"and"` requires EVERY leg PRESENT at that severity to fire,
 * so it can only ever shrink a tier's firing set. Amber and Red are independent: an id may fold
 * `or` at Amber (recall-first warning) and `and` at Red (confirmation-first alarm).
 *
 * Non-numeric by design — it names a combinator, never a threshold — so it is deliberately NOT
 * scaled by the earliness multiplier (`scaleCuts`, domain-cuts.ts).
 */
export type FoldPolicy = { amber?: "or" | "and"; red?: "or" | "and" };

/** Where a head obs came from: a running `bar` on the id's own series, a live `quote` on it, or a `proxyCarry` off a lead. */
export type ObservationSource = "bar" | "quote" | "proxyCarry";

export interface Observation {
  date: string;
  value: number;
  /** A quote/estimate head, not an official print — the persist path stores its readings `estimated` (`estimateDatesOf`). */
  estimated?: boolean;
  source?: ObservationSource;
}

/** The ONE head-obs constructor: `estimated` ⇔ `source ≠ "bar"` — never set the two fields by hand. */
export function headObs(date: string, value: number, source: ObservationSource): Observation {
  return source === "bar" ? { date, value, source } : { date, value, source, estimated: true };
}

/** The ONE feed-parser tail: last value per date wins (insertion order), ascending by date. */
export function observationsByDate(byDate: ReadonlyMap<string, number>): Observation[] {
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * All four bounds are optional: a level-only indicator (R1 term spread, R5 VIX)
 * omits the velocity bounds; a velocity-only indicator (R2/R3 yield shock)
 * omits the level bounds. An omitted bound simply never fires (§4 Family B).
 */
export interface Thresholds {
  amberLevel?: number;
  redLevel?: number;
  amberVelocity?: number;
  redVelocity?: number;
  /**
   * PRESENT ⇒ the velocity pair above is in **σ units, not the series' own units**
   * (F9 is the first and
   * only member). The scored quantity becomes `z = Δw / σ`, with σ estimated over a
   * STRICTLY HISTORICAL rolling window of `window` velocity deltas ending at `t−1`, so
   * the scored day never enters its own scale. Below `minObs` usable deltas the day
   * DEGRADES (z undefined ⇒ the leg is dark) rather than scoring off a thin σ.
   *
   * This one field is the ONLY discriminator, read in exactly two places:
   *  - `scoreDaySeries` (domain-fold.ts) — builds the σ/z series and passes the day's z
   *    in as `velZ`, the same scalar seam the proxy/`calibratedZ` paths use;
   *  - `legBounds` (domain-legs.ts) — routes the registry pair to the `vel-z` leg
   *    (axis `vel-sigma`) instead of the raw-units `vel-op` leg.
   * Absent ⇒ byte-identical behaviour for every other id.
   *
   * ⚠ The `window` is a CAP, not a promise: σ is estimated over every usable delta in
   * `[t−window, t−1]`, so a shallow history yields a shallower σ. The CRON path is no
   * longer the binding constraint — `velocitySigmaFetchOpts` (fred.ts) widens a σ id's own
   * FRED fetch to `window + velocityWindow` trading days, leaving every other id's fetch
   * untouched. What still caps it: the SERIES' own start date, the store-fallback read
   * limit on a failed live fetch, and any caller that hands in a pre-sliced window.
   * `minObs` is what makes every one of those shortfalls degrade rather than score.
   */
  velocitySigma?: {
    window: number;
    minObs: number;
    /**
     * The ONE-SIDED CUSUM persistence leg's three knobs.
     * **OPTIONAL as a TRIPLE (2026-08-09, F11 ruling 5): a σ id that omits
     * them has a SPEED leg (`vel-z`) and NO persistence leg** — no `vel-cusum` bound, no S⁺ fold,
     * no `cusum` wire key, no secondary axis. Every consumer resolves them through `cusumParams`
     * (domain-legs.ts), which returns `undefined` unless all three are present, so a HALF-declared
     * block silently disables the leg rather than half-wiring it. ⚠ Nothing pins the cusum-ABSENT
     * path (F11's own arc dropped that test arm by ruling): a future edit that re-gates a consumer
     * on `velocitySigma` presence instead of `cusumParams` re-enables F11's secondary axis with
     * every test green. The recurrence is `S⁺_t = max(0, S⁺_{t−1} + z_t − cusumK)` over the SAME z the
     * `vel-z` speed leg scores (ruling 2 — "one z, two legs", no second standardization), and
     * the `vel-cusum` leg is TWO-TIER over the resulting accumulator (2026-08-09 §3.6a). `cusumK`
     * is read in one place, `velocityCusumSeries` (domain-fold.ts). Each bound is read in exactly
     * ONE place too — `cusumAlarmBound` / `cusumRedBound` (domain-legs.ts) — because a bound's
     * consumers (its `legBounds` entry, the reset test in the recurrence, the drawn band on the
     * detail chart's secondary axis) MUST all be the same number.
     *
     * ⚠ **The textbook ARL tables do NOT deliver their false-alarm rate here.** They assume
     * i.i.d. standard-normal input; z is `Δw / σ`
     * over DAILY-sampled w-day changes that overlap by `w − 1` observations and are therefore
     * ~98% autocorrelated, so consecutive z's are near-identical and S⁺ accumulates far faster
     * than the model predicts — the leg over-fires, which is what the reset now bounds. Shipped
     * by `[USER]` ruling (2026-08-08b scope ruling 2) with the empirical-`h` calibration DECLINED —
     * **RE-RULED and unchanged 2026-08-09**: because the ARL tables do not apply
     * here, no measured `h` sweep is owed. ⛔ Do not re-open it as "the bound must carry the rest of
     * the loudness".
     * ⛔ That round's second half — "neither bound moves on a `cusumK` retune" — is SUPERSEDED (§3.12):
     * both bounds moved WITH the offset, hand-set to meet it, which is not the calibration the decline
     * refuses. The bounds track `cusumK`'s in-control level; they are still never swept.
     * ⚠ `cusumH` is the FIRE TEST ONLY — it is absent from the recurrence above, so it cannot change
     * how high `S⁺` climbs. An episode that never reaches it is a `cusumK` question, never an `h` one.
     * ⛔ That ruling's "`h` is retuned off `/lab` like every other cut" is SUPERSEDED (2026-08-09): `cusumK` AND
     * `cusumH` were hand-picked off measured sweeps instead — still hand-set cuts, not a calibration.
     * ⛔ §3.4a's "near-inert / never cite the leg's presence as evidence it works" is VOID (§3.5a):
     * it measured the RETIRED `cusumK`, at which the leg added single-digit days over `vel-z` — itself
     * differenced against a σ pair since retired (round 5), so that figure is doubly historical. The
     * shipped `cusumK` makes the leg materially talkative — but no retained figure describes the
     * shipped leg (provenance §F9), so read no pre-§3.5a figure as describing it.
     *
     * TWO-TIER (2026-08-09 §3.6a, `[USER]`; SUPERSEDES the AMBER-ONLY assignment this docblock
     * used to carry — CUSUM CAN now drive a σ id to RED on its own). `cusumH` is the SPC WARNING
     * limit and backs the leg's AMBER bound; `cusumHRed` is the ACTION limit and backs its RED
     * bound. The recurrence FIR-restarts `S⁺` to `cusumHRed/2` at the ACTION limit (2026-08-11
     * `[USER]`) — never at the warning limit, which would cut the accumulator down the moment it
     * signalled and leave the red line unreachable except by a single outsized step.
     */
    cusumK?: number;
    cusumH?: number;
    cusumHRed?: number;
    /**
     * BLENDED ESTIMATOR, opt-in as a pair: σ = `max(EWMA(ewmaHalfLife), ewmaFloorFactor × rect(window))`.
     * **Absent ⇒ rectangular** — F9 and every other id are unchanged by construction, not by assertion.
     */
    ewmaHalfLife?: number;
    /** Floor multiple on the rectangular arm; defaults to 0 (EWMA alone) when `ewmaHalfLife` is set. */
    ewmaFloorFactor?: number;
    /**
     * OPT-IN second Δ horizon: z'd by this same estimator config and scored as the `vel-z-fast`
     * OR-leg against the SAME σ-multiple pair. Absent ⇒ no fast leg — every other id unchanged.
     */
    fastWindow?: number;
  };
}

/**
 * How a bespoke scorer's *plotted* series maps to the *decision variable* it
 * actually thresholds on. Lets the detail chart draw bands for indicators whose
 * cut-points aren't horizontal lines on the plotted price (F4/G1/NVDA/F5).
 *  - "return":   trailing return over `window` obs   (v[i]/v[i-window] - 1)
 *  - "maSpread": % distance from the trailing MA     (v[i]/mean(window) - 1)
 *  - "highDist": % distance from the rolling high     (v[i]/max(window) - 1)
 *  - "lowRise":  rise from the rolling low, LEVEL units (v[i] - min(window))
 *  - "worstDrop": worst close off the running high inside the window ending at i (min v[k]/max(v[start..k]) - 1)
 *  - "change":   trailing change over `window` obs, LEVEL units (v[i] - v[i-window]); polarity as "return"
 *  - "identity": plot the value directly (cut-points already in plotted units)
 */
export type DerivedKind = "return" | "change" | "maSpread" | "highDist" | "lowRise" | "worstDrop" | "identity";

export interface DerivedView {
  kind: DerivedKind; // transform from plotted series → decision variable
  window?: number; // lookback in observations (omit for "identity")
  amber: number | null; // band in DERIVED units (e.g. -0.15); null = no amber band
  red: number | null; // band in DERIVED units; null = no red band
  label: string; // secondary-axis label, e.g. "6-mo return"
  unit: string; // "%" multiplies by 100 on the 2nd axis; "" = unitless
  // Display only (persisted, or KBE's stamped on read in api/series.ts) — NO scorer scores its bands
  // (`kind` + `window` still feed the persisted `decision` via `decisionAt`), and
  // presence must NOT reroute the id off its serve path (`api/series.ts` canRecompute + app.js `isDerived` honour it).
  displayOnly?: true;
}

/**
 * Post-inversion floor rung: ≥qualifyN consecutive obs <0 arm; while armed, GREEN→AMBER while the
 * value < the expanding-percentile cut (floorLevel = warm-up hold + release threshold); releaseN
 * consecutive obs ≥ floorLevel disarm. R1/R8 arm it over their trailing MEANS, not the raw closes.
 */
export interface PostInversionCooldown {
  qualifyN: number; // consecutive obs < 0 that arm the rung (the series the carrier scores — MEANS on a smoothed carrier, else raw closes)
  floorLevel: number; // warm-up hold for the armed cut + the release threshold; a close below it resets the release run
  releaseN: number; // consecutive closes ≥ floorLevel that disarm — released by LEVEL, no time expiry
  cutPctile?: number; // expanding-percentile rank of the armed cut over the anchored pool of raw closes; REQUIRED unless `levelCuts` supersedes it
  cutWarmupObs: number; // pool sizes below this hold floorLevel as the armed cut
  cutClamp?: [number, number]; // [lo, hi] clamp on the percentile cut; REQUIRED unless `levelCuts` supersedes it
  cutAnchorDate: string; // YYYY-MM-DD — obs dated before it never enter the pool
  /**
   * MEAN-SPACE rung (R8): presence flips the whole rung into mean space — arming counts MEANS < 0,
   * release counts means ≥ floorLevel, and these TWO armed expanding-percentile cuts (over the
   * anchored pool of means) supersede both the registry level pair and `cutPctile`/`cutClamp`.
   * During warm-up (pool < `cutWarmupObs`) the amber cut holds `floorLevel`; the red cut is ABSENT
   * (no red until the pool is deep enough to rank one). Disjoint clamps (`amber.clamp[0] >
   * red.clamp[1]`) structurally keep red < amber forever.
   */
  levelCuts?: {
    amber: { pctile: number; clamp: [number, number] };
    red: { pctile: number; clamp: [number, number] };
  };
  shortLegSeries: string; // FRED id of the short (3m) leg the steepener escalation reads
  shortLegWindow: number; // trailing short-leg obs window for the bull-steepening gate
  // Min short-leg FALL in bp over the window; an armed sub-floor bull day escalates raw → RED
  // (`steepenerEscalationSeries`, scorers-core.ts). No aligned short obs ⇒ gate off for the day.
  shortLegDropBp: number;
}

/**
 * ALWAYS-ON regime-relative drawdown leg (un-wired from R1 since 2026-08-31, pinned on fixture
 * carriers) — deliberately NOT a `PostInversionCooldown` field: it must never inherit the rung's arming,
 * because the blind spot it closes is exactly the calm regime in which the rung is unarmed and a carrier
 * falls back to its static pair.
 *
 * AMBER when the close sits `dropPp` below the max of the trailing `window` obs (INCLUSIVE of today)
 * AND the short leg moved ≥ `gateBp` bp in EITHER direction over the trailing `gateWindow` obs. The
 * gate is direction-AGNOSTIC on purpose: bull-only was measured and rejected (blind to a
 * hiking-driven flattening; the 2020 lead collapses 471d → 187d).
 *
 * ⛔ The leg NEVER emits RED — RED stays the inversion cut plus the armed rung's bull escalation.
 * A RED escalation here costs the 2025 pattern (an easing cycle holding RED for months).
 * Values live ONLY on the registry object (`T10Y3M_DRAWDOWN`, registry-fred.ts).
 */
export interface DrawdownLeg {
  window: number; // trailing obs the running max is taken over, inclusive of today
  dropPp: number; // percentage points below that max at which the leg fires
  gateWindow: number; // trailing short-leg obs window for the direction-agnostic move gate
  gateBp: number; // min ABSOLUTE short-leg move in bp over that window; no aligned short obs ⇒ gate off
}

/** How deep ONE indicator's backfill fetch reaches beyond the floor. Exactly one of the three forms —
 *  `years` for a feed bounded by the shared trim, `days` for a feed with its own cal-day window,
 *  `since` (ISO date) for a fixed origin a cron arm already stores from. */
export type BackfillDepth = { years: number } | { days: number } | { since: string };

/** ONE indicator's same-day estimator, a literal on its registry row: the lead symbols it carries its print over and
 *  the pinned constants. `gateFailed` = it failed its pre-registered gate — its rows are display-only. */
export type Estimator =
  | { kind: "carry-log"; leads: readonly [string]; beta: number; cutPct: number; gateFailed?: true }
  /** Multiplicative carry `print × (L_t/L_t0)^β` — `nowcastOilSpots`' math, NOT the oil lane (`carry-log`). */
  | { kind: "carry-mult"; leads: readonly [string]; beta: number; gateFailed?: true }
  | { kind: "carry-level"; leads: readonly [string] | readonly [string, string]; beta: number; gateFailed?: true }
  | { kind: "carry-ratio"; leads: readonly [string, string]; beta: number; gateFailed?: true }
  /** The id's own FRED-leg scorer re-runs over its legs, each extended by `vixEstimatePoints` (run-cycle-confirmers.ts): VT/VXNT's VIX legs
   *  carried over the live `^VIX`/`^VIX3M` at beta 1 (R5's form), VXNT's VXN leg by VXNCLS's `carry-mult`; rows via `buildEstimateRows`. */
  | { kind: "leg-ratio"; leads: readonly [string, string]; gateFailed?: true };

export interface Indicator {
  id: string; // "F1"
  label: string; // SHORT market-shorthand name — the primary visible text (ntfy lines, chart legends, tiles): "HY OAS", "SMH/SPY"
  // The full descriptive name, rendered in hover/aria text alongside the id. REQUIRED so tsc
  // enumerates any registry entry that forgot one.
  longLabel: string; // "Credit appetite (HYG/LQD)"
  series: string; // FRED series id, price-feed ticker, or dedicated-feed key (EBP: "ebp", scored outside the FRED loop)
  channel: Channel; // which roll-up it feeds (v4 §6.2)
  thresholds: Thresholds;
  // The PRE-multiplier registry thresholds, stamped by `withMultipliedThresholds` only when
  // the earliness multiplier `m !== 1` (at `m === 1` `thresholds` already IS raw, so the
  // canonical read is `rawThresholds ?? thresholds`). Exists for the Stage-6.3 synth seam:
  // a cut fed INTO `resolveCuts` must never have seen `m`, because `scaleCuts` applies it.
  rawThresholds?: Thresholds;
  direction?: Direction; // level polarity; defaults to HIGH
  // Post-inversion rung — R8 a `levelCuts` carrier over its means, R1 a plain object armed over its
  // 21-obs means via the SMOOTHED_LEVEL_OF branch (values one-place each in registry.ts); absent ⇒ no rung.
  postInversionCooldown?: PostInversionCooldown;
  // ALWAYS-ON regime-relative drawdown leg (un-wired from R1 since 2026-08-31) — independent of the
  // rung above's arming; absent ⇒ no leg. AMBER-ONLY by ruling (2026-08-30).
  drawdownLeg?: DrawdownLeg;
  unit?: string; // value suffix in the payload; defaults to "%"
  // Seed depth this id backfills to; absent ⇒ the shared `BACKFILL_WINDOW.depth`. Read through
  // `backfillDepthFor` (scripts/restate-policy.ts) — never off the entry directly.
  backfill?: BackfillDepth;
  // Same-day estimator; absent ⇒ the id writes no `estimated` row. Read through `estimatorOf` (nowcast-score.ts).
  estimator?: Estimator;
  // RELEASE schedule — how often this feed PUBLISHES, which is not necessarily the grid its
  // observations sit on (that is `obsCadence` below, whose docblock carries the trap and is
  // the field every velocity caption resolves through as `obsCadence ?? cadence`; the SPAN
  // comes from the id's own `velocityWindow`, not from this field and not from a literal 20).
  // Drives the per-cadence lag threshold (ladder.ts LAG_THRESHOLDS: a
  // weekly FRED release e.g. F3 NFCI / the H.10 FX legs lags a full release cycle
  // by design, so it must NOT flag as lagging at the daily cut). Defaults to "daily"; which ids
  // declare otherwise is `registry.ts`'s to say — a per-id census here rots on the next id and
  // that staleness is exactly what hid three mis-captioned ids (2026-08-07). "quarterly" is
  // currently CARRIED BY NOTHING — F12
  // (credit impulse) was its sole carrier until its 2026-07-17 retirement (DEC-21); the
  // variant and its downstream label/lag branches are kept for the next sparse
  // feed rather than churned out and back in. Beyond the lag cut it is display-only, and it
  // reaches freshness only via the /status age surface.
  cadence?: Cadence;
  /**
   * The OBSERVATION grid this feed's rows sit on — the unit `delta20` (and any
   * `velocityWindow`) actually steps over. `cadence` above is the RELEASE schedule; for most
   * ids the two coincide and this field is absent (⇒ read `cadence`, whose own default is
   * daily). Declare it ONLY where they diverge, and every consumer that captions or units a
   * velocity span resolves `obsCadence ?? cadence` — never `cadence` alone.
   *
   * ⚠ TRAP, and the whole reason the field exists: **G1/BRENT are weekly-RELEASED,
   * BUSINESS-DAY observed.** They carry `cadence: "weekly"` for the EIA release (and the
   * `lagAfterDays` slip it earns), but `DCOILWTICO`/`DCOILBRENTEU` return business-day rows, so a
   * bare `obsWord(i.cadence)` (`chart-rail.ts`) would caption a 60-trading-day move **"Δ60w"** — a
   * 5× error, on the card the cuts are read off. F9/F11 were carriers until 2026-08-10, when they
   * moved to `USDU`/`CNY=X` (`FEED_OF`, registry.ts) and their grids converged on `cadence: "daily"`.
   *
   * Id-level by design: F9 left `CHART_PARAMS_OF` when its level axis was retired
   * (2026-08-07), so the older `dualAxis.obsCadence` — which only a dual-axis id could carry —
   * could not reach it. That nested field is RETIRED; this one subsumes it.
   */
  obsCadence?: Cadence;
  /**
   * PER-INDICATOR lag cut, in CALENDAR days, overriding `LAG_THRESHOLDS[cadence]`
   * (ladder.ts) for this id only — resolved at exactly one place, `lagCutFor` (ladder.ts),
   * which every consumption point routes through (`verdictHoldLegs`, `stampFreshness`,
   * `/api/status`, `/lab`'s freshness stamp + `LAG_CUT_OF`). Absent ⇒ the cadence table
   * decides, i.e. every other id is byte-unchanged — `LAG_THRESHOLDS` itself does NOT
   * move (it stays the fallback AND `feed-lag.ts`'s tier ladder, which reads the TIER, not
   * this override).
   * FOR: a source whose published RELEASE calendar is slower or more irregular than its
   * cadence tier's cut (E7 — an H.10 weekly release is newest for 9d, 10d on a holiday
   * slip, so `weekly`'s 9 flags a normal week). The cut must come from the publisher's
   * documented schedule, never from the age we happened to observe.
   */
  lagAfterDays?: number;
  /**
   * PER-SOURCE publication-calendar timezone — which calendar date this feed's publisher thinks
   * it is. Pairs with `lagAfterDays` above: that one sets HOW MANY days late is too late, this
   * one sets what a "day" is measured against. Absent ⇒ `FEED_CALENDAR_TZ` (dates.ts), which is
   * US Central because FRED dominates the set; see that constant for why Central and not Eastern.
   * FOR: a feed on a genuinely different national calendar — the Frankfurt-published ids (EURC via
   * ECB, BUND via sovereign-quote `DE10Y-DE`/`DE2Y-DE`) carry `Europe/Berlin`.
   * NOT for cosmetics: this only ever changes a whole-day date difference, never a displayed time.
   *
   * ⚠ UNVALIDATED BY THE TYPE. It is a bare `string` (an IANA-zone union is not in the stdlib) and
   * it flows into `toLocaleDateString`, which THROWS `RangeError` on an unknown zone — on the
   * `/api/status` GET path, which has no try/catch, so a typo here is a 500 on the whole endpoint.
   * The only thing that catches that is the `Intl.supportedValuesOf("timeZone")` guard in
   * `registry.test.ts`, which walks `feedTimeZoneIndex()` (feed-lag.ts) — the served registry PLUS
   * `COMPOSITE_COMPONENTS`, i.e. the same population `/api/lab` resolves over. Any NEW carrier of
   * this field must be reachable from that one walk, or it sits outside the guard.
   */
  feedTimeZone?: string;
  // Coincident CONFIRMER (Phase-2 C3, EBP): within its channel, a confirmer only
  // adds its state-rank once the channel's NON-confirmer base is already elevated,
  // and is excluded from the escalator base score (alert-band.ts RATE floor; the
  // legacy red-count rule is frozen in the replay engine).
  // It can raise/confirm severity but can never independently trip an alert.
  confirmer?: boolean;
  // Detail-chart descriptor for bespoke scorers (F4/G1/NVDA/F5) whose decision
  // variable is derived (return/MA-spread/high-distance), not the plotted price.
  // Absent = the chart draws level/velocity bands from `thresholds` (current path).
  derived?: DerivedView;
  /**
   * PER-INDICATOR velocity lookback, in observations, overriding the global
   * `VELOCITY_WINDOW` (20) for BOTH the scored velocity leg (`scoreDaySeries`) and the
   * emitted/persisted `delta20` (`buildReadings`). Absent ⇒ 20, i.e. every other id is
   * byte-unchanged — `VELOCITY_WINDOW` itself does NOT move (it still fixes the
   * `observations[VELOCITY_WINDOW..]` alignment slice, the z-series length guard, the
   * `buildReadings` baseOffset and `v-bear.ts`'s derived `V_VELOCITY_CUT`).
   * ⚠ ANY override — shorter or longer — changes what the 20-NAMED `delta20` column means for
   * the carrier: F1 (`velocityWindow: 30`, EW-4/D-A) persists a 30-day change under it, and
   * `notify_format.ts` labels the span off this field so the alert copy stays honest.
   * ⚠ `w > VELOCITY_WINDOW` is ALLOWED and shipped (F1, and F9 since 2026-08-07) — the old
   * "must be ≤ `VELOCITY_WINDOW`" claim was false from F1 onward. What it actually costs: the
   * fold still starts at index `VELOCITY_WINDOW`, so the first `w − VELOCITY_WINDOW` scored
   * rows have `i − w < 0` and their delta is CLAMPED to a change off `values[0]` — a SHORTER
   * span than `w` (`scoreDaySeries` in domain-fold.ts, `buildReadings`' `Math.max(0, …)` in
   * scorers-core.ts). The synth velocity cut, meanwhile, is fitted on UNCLAMPED |Δ| only
   * (`absDelta` starts at `w`, which is why the golden records `nObsVelocity = nObs − w`), so
   * those leading rows are compared against a cut drawn from full-span moves and the series
   * head systematically UNDER-fires. It is a head-of-history artifact, not a live-tail one.
   * The card-vs-state invariant survives it: both the scored and the emitted/persisted
   * `delta20` clamp identically, so the printed number is always the one that was scored.
   */
  velocityWindow?: number;
  /** `"relative"` ⇒ the velocity leg and `delta20` are `Δw / v[i−w]` (a fraction; cuts too); absent ⇒ absolute Δ.
   *  The one formula is `velocityDeltaAt` (domain-fold.ts). */
  velocityMode?: "relative";
  /**
   * PROVISIONAL cuts (EW-19): this indicator's shipped cut-points are **measured but
   * NOT optimized** — no overfit gate ran (no PBO/DSR C6 pass, no replay recall guard),
   * so they are a published percentile of an unconditional distribution rather than a
   * gate-cleared operative cut. A typed FIELD, not a comment, precisely so a future
   * drift-guard / provenance sweep can enumerate the flagged ids instead of grepping
   * prose. Absent ⇒ the indicator makes no such claim (either hand-authored convention
   * priors, or gate-passing `op*` cuts). Carried by F1 since EW-R1 Stage 2.2.
   */
  provisional?: true;
  /**
   * Scorer-logic vintage — hand-bump on a scorer-BODY rewrite the config hash cannot see
   * (`scorer-vintage.ts` hashes the registry ENTRY; a function reference on it stringifies to
   * nothing, so a body edit is invisible to the hash); absent = 1.
   */
  logicVersion?: number;
  /**
   * GEO-channel ONLY — the underlying RISK FACTOR this id reads, stated here (where the ids
   * live) rather than in a lookup table beside the counting site
   * ("stated where the ids live, not
   * duplicated"). `escalatorFloorBreakdown` (alert-band.ts) counts DISTINCT factors among the
   * lit GEO readings, so several reads of one factor (G1 + BRENT + OVX are three reads of oil)
   * buy ONE geo flag between them, not three. Hand-maintained by design — the accepted cost —
   * and guarded by alert-band.compose.test.ts's every-GEO-id-has-a-factor assertion, so a new GEO id in
   * `ALL_INDICATORS` cannot ship untagged. ⚠ That assertion's population is `ALL_INDICATORS` only —
   * a GEO-channel id kept OUT of it (VTP is censused in `FAMILY_OF` but excluded) would reach
   * `escalatorFloorBreakdown` untagged and never trip the guard; the `?? id` fallback bounds that to
   * pre-§11.1 loudness. Absent on non-GEO ids, where nothing reads it.
   */
  geoFactor?: string;
}

export interface Reading {
  indicator: Indicator;
  date: string;
  level: number;
  delta20: number;
  rawState: State; // today's unconfirmed state
  state: State; // confirmed state (the one that counts)
  // The per-point DECISION VARIABLE — the scalar the derived scorer compares against
  // its amber/red bands (return / MA-spread / high-distance of the plotted `level`),
  // captured at scoring time so the read path serves it verbatim instead of re-deriving
  // it (Case 2, single-source-at-cron). NULL for a non-`derived` indicator and for a
  // point whose lookback window is short (a gap the FE renders as a line break).
  // Optional so hand-built test/backtest Reading doubles need not spell it; `buildReadings`
  // (the ONE scored constructor) always sets it, so every cron/backfill reading carries it.
  decision?: number | null;
  // The resolved numeric cut legs the scorer classified this reading against — the ONE cut
  // the cron scorer used (an expanding-percentile value for a synth id, a static registry cut
  // otherwise), captured at scoring time so Stage 2.2 can read it verbatim instead of a
  // coordinated recompute. `null`/undefined for a bespoke scorer that reads registry
  // thresholds directly (resolved cuts `{}`). Persisted to `readings.band_cuts` (jsonb) via
  // `toStoredReadings`→`readingRow`; a plain numeric record so `domain-types` (zero imports)
  // needs no edge onto `CalibrationCuts` (`domain-cuts.ts`, which imports THIS file).
  bandCuts?: Readonly<Record<string, number>> | null;
  // The winning OR-leg that attributed this day's CONFIRMED state (`winningLeg`), e.g. a
  // level- vs velocity-class firer — the per-day attribution D3 Stage 2 surfaces.
  // IN-MEMORY ONLY: `readingRow` (store.ts) maps column-by-column via READINGS_COLS, so
  // this never reaches the DB and needs no migration; the read path recomputes it from
  // full history (api/series.ts' `indicatorLegSeries` is the shipped precedent).
  // Undefined where raw disagrees with confirmed (attribution suppressed), and on any
  // `buildReadings` caller that doesn't supply the optional `legs` array.
  leg?: string;
  // The winning OR-leg off the RAW (unconfirmed) inputs — the same attribution as `leg`
  // but WITHOUT the raw-vs-confirmed agreement gate, so it is populated exactly on the
  // boundary days where `leg` is suppressed. Feeds the provisional push (naming which leg
  // breached on a raw RED that has not yet confirmed).
  // IN-MEMORY ONLY, same as `leg`: `readingRow` (store.ts) maps column-by-column via
  // READINGS_COLS, so this never reaches the DB and needs no migration.
  rawLeg?: string;
  // FEED FRESHNESS at the reading layer (OQ-5 Stage 5.1, discharging S-4): `ageDays` is this
  // observation's age against an INJECTED evaluation clock — in the feed's own PUBLICATION
  // SLOTS for a daily/weekly id and in CALENDAR days for a monthly/quarterly one, read
  // `unit` below — and `lag` is that age measured against the indicator's own resolved cut.
  // Both come from `stampFreshness` (scorers-core.ts), the run path's ONE freshness
  // computation since slice 3 (2026-09-09), which re-declares no threshold and resolves
  // through `lagCutFor` (ladder.ts + LAG_THRESHOLDS) exactly as the read path's
  // `freshnessFrom` does — so the stamp cannot disagree with it, nor with the notify seam's
  // `verdictHoldLegs`, which now READS this stamp rather than computing a second one.
  //
  // ⚠ UNDEFINED MEANS "NOT ASSESSED", NEVER "FRESH". A Reading built without an
  // evaluation clock (every `buildReadings` caller — the scorers hold no clock, and
  // defaulting one to the series' own newest date would report a frozen feed as
  // 0d-old fresh, which is the exact `?? "calm"` / `?? 1` defect class this plan
  // exists to kill) leaves both fields undefined. Consumers must branch on
  // undefined rather than coalescing it to a value.
  //
  // IN-MEMORY ONLY, same as `leg`/`rawLeg`: `readingRow` (store.ts) maps
  // column-by-column via READINGS_COLS, so this never reaches the DB and needs no
  // migration. Deliberate: lag is a fact about the
  // *evaluation
  // clock*, not about the observation — a persisted `lag` would be frozen at
  // write time and read back as a lie on every later day, and the read path can
  // always recompute it from the stored `obs_date` + the registry cadence (which is
  // exactly what `api/status.ts` already does).
  ageDays?: number;
  lag?: boolean;
  /**
   * The UNIT of `ageDays` (slice 3, 2026-09-09). `"slots"` — the feed's own PUBLICATION days,
   * `slotAge` against a containment grid — for every `daily`/`weekly` id; `"days"` — calendar days —
   * for `monthly`/`quarterly`. Stamped by the SAME `Freshness` return `assessIndicatorFreshness`
   * carries, so the number can never be paired with the wrong unit. Undefined alongside an undefined
   * `ageDays` = not assessed. IN-MEMORY ONLY, like the pair above.
   */
  unit?: "slots" | "days";
}
