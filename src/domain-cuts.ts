/**
 * Indicator domain — the calibration-cut resolution layer (Stage 5c leaf 2 of 4).
 *
 * Imports only `domain-types.js` plus the two runtime leaves below `domain` (no
 * registry/scorer import): `threshold-config.js` (JSON-only) and
 * `family-descriptor-rows.js` (type-only imports upward), so neither introduces a
 * cycle.
 *
 * IMPORTANT: FRED reports credit-spread OAS in PERCENT, not bps.
 * 3.42 means 342 bps. All thresholds below are in percent.
 */

import { resolveMultiplier, earlierCutOpt, type ThresholdConfig } from "./threshold-config.js";
// NO value import from `family-descriptor-rows.js` any more: the four `BAA10Y_*` bounds were pulled in
// here ONLY by the `map.proxy ? …` cut expressions that injected them as F1/F2's borrowed z /
// vel-z bounds. Stage 5.2 (2026-08-06) deleted those expressions, so the imports went with them —
// `tsconfig` sets no `noUnusedLocals`, so nothing but a grep would have caught them surviving.
import type { Direction, FoldPolicy, Thresholds } from "./domain-types.js";

/**
 * The measured cut-points the off-line harness publishes for one indicator,
 * resolved from a `getCalibration()` vintage (threshold-provenance plan Phase 1).
 * Every field is optional: an absent calibration row leaves that leg undefined, so
 * an empty/partial vintage can only ever make an indicator fire EARLIER, never
 * silence it (Decision 2 — the absolute convention is the floor).
 *  - `evtAmber`/`evtRed`: EVT tail-level cut in the indicator's OWN series units
 *    (own-series indicators only). INCLUSIVE comparison, flipping with `direction`
 *    (`level ≥ cut` HIGH / `level ≤ cut` LOW) — mirrors the harness `≥`/`≤`, NOT the
 *    absolute leg's STRICT `>`/`<`. NOTE: under the current calibration every mapped
 *    EVT cut is MORE extreme than its absolute convention (R5 33.2 vs 25; R1 −0.65 vs
 *    0.5 — EBP was a third until its 2026-07-29 retune closed the gate), so the OR-floor (Decision 2)
 *    means the absolute fires first and the EVT-level leg adds ZERO live firings.
 *    The real "fires earlier" benefit comes from the z-leg; the EVT-level leg is wired
 *    for completeness / future recalibration, not current early-warning gain.
 *  - `zAmber`/`zRed`: regime-relative z-score cut (σ). Fires when the point-in-time
 *    z reaches it, the z computed off `zrefMean`/`zrefStd`.
 *  - `zrefMean`/`zrefStd`: the harness's full-history reference distribution for the
 *    z-leg (Decision 4 — published as small params so the live scorer needs NO
 *    stored history). Absent until Phase 2 ⇒ the z-leg can't compute ⇒ it's skipped.
 */
export interface CalibrationCuts {
  evtAmber?: number;
  evtRed?: number;
  zAmber?: number;
  zRed?: number;
  zrefMean?: number;
  zrefStd?: number;
  /**
   * The VELOCITY measured leg for velocity-only indicators (R2/R3/R4) — a SEPARATE
   * bound-set so a velocity id's EVT/z cuts compare against `delta20` (the 20-day
   * change the harness references) instead of `level` (qimpag 2026-06-30 P3-follow).
   * The harness publishes these under the same `<prefix>_<cut>` metric names, but its
   * reference distribution is built on the velocity rows, so they MUST be applied to
   * `delta20`, never `level`. Velocity is always HIGH polarity (a fast rise is the
   * shock), so these legs do NOT flip with `direction`. `velZ` is computed inline by
   * `rawStateSeries` off `velZrefMean`/`velZrefStd` (always own-series — no proxy
   * velocity case — so unlike the level z-leg it needs no threaded series).
   */
  velEvtAmber?: number;
  velEvtRed?: number;
  velZAmber?: number;
  velZRed?: number;
  velZrefMean?: number;
  velZrefStd?: number;
  /**
   * OPERATIVE measured cuts (modes-and-markets ② Decision 2): the harness emits
   * `<prefix>_operative_{amber,red}` ONLY for cuts that passed BOTH the C6 overfit
   * gate (PBO<0.5 ∧ DSR≥0.95) AND the replay recall guard (no precedent episode
   * loses WARNING+ under the swap). When present, an operative bound REPLACES the
   * convention absolute leg for its band — a gate-passing tighter cut can bind —
   * superseding the unconditional Decision-2 OR-floor for gate-passers only. The
   * EVT-OR and z legs are unchanged, and an absent operative leaves the absolute
   * behavior byte-identical (convention stays the degrade fallback). `velOp*` is
   * the velocity-id variant, compared against `delta20` like the other vel legs.
   */
  opAmber?: number;
  opRed?: number;
  velOpAmber?: number;
  velOpRed?: number;
  /**
   * How the legs above COMBINE at each severity (`FoldPolicy`, domain-types.ts) — absent ⇒ `"or"`
   * at both tiers, the shipped semantics. Sourced from `FOLD_POLICY` below by `resolveCuts`, not
   * from any published calibration row: it is a fold, not a cut.
   *
   * NON-NUMERIC, and deliberately NOT scaled by `scaleCuts` — that function spreads `...cuts` and
   * then names the 12 numeric legs one by one, so this field rides through untouched. Adding it to
   * the earliness transform would be a category error (there is no "earlier AND").
   */
  fold?: FoldPolicy;
}

/**
 * Which indicators fold their OR-legs with a non-default combinator, keyed by indicator id.
 *
 * F1, F2 and CCC (`[USER]` 2026-10-20) carry option D:
 * AMBER = the level OR the velocity leg, RED = BOTH — a wide spread that is ALSO widening.
 * F1/F2's borrowed Baa10y proxy-z legs were retired 2026-08-06 and the whole proxy-z path deleted
 * 2026-08-06 (Stage 5.2), so the legs present on both ids are exactly `op` (level) and `vel-op`
 * (velocity) — the AND at Red is the two-leg arm trigger the verdict ruled and nothing else.
 *
 * Adding a further id is ONE line here — the attribution key, its phrase, its velocity class and
 * the parity test all derive from the key's shape (E6), so no test, pin, docblock or probe work
 * follows.
 *
 * WHY ITS OWN TABLE, not a `CALIB_MAP` field: after the z retirement the ids this arc arms
 * (F1/F2) resolve NO calibration cut at all, and `resolveCuts` returns `{}` early on an absent
 * `CALIB_MAP` entry. Stage 5.2 then DELETED `CALIB_MAP.{F1,F2}` outright, and the fold survived
 * unchanged precisely because it is sourced independently of `CALIB_MAP` —
 * had it been a `CALIB_MAP` field, that deletion would have silently reverted Red to `"or"`.
 */
const FOLD_POLICY: Readonly<Record<string, FoldPolicy>> = {
  F1: { amber: "or", red: "and" },
  F2: { amber: "or", red: "and" },
  CCC: { amber: "or", red: "and" },
};

/**
 * Which calibration `(channel, metricPrefix)` feeds each LIVE indicator, and whether
 * its EVT-level leg applies. Keyed by indicator ID — the TS `Channel` (FIN/RATE/…)
 * is NOT the calibration channel (credit/rate/vol) (reviewer N1). `getCalibration()`
 * returns a FLAT param list, one row per `(channel, metric)` where metric is
 * `<prefix>_<cut>` (e.g. `t10y3m_evt_level_amber`), so each cut is a separate lookup
 * (reviewer I3).
 *
 * `legs` / `ownZ` / `evtLevel` — THREE INDEPENDENT axes, deliberately explicit
 * (Stage 6.2a). `legs` was once a single `velocity?: boolean` carrying three meanings at
 * once (routing + own-z exclusion + the drawn chart line); an id with BOTH a level and a
 * velocity axis could not be expressed, and any new flag that only routed would silently
 * compute a spurious own-level z and swap the chart lines. Each axis now says one thing:
 *  - `legs: { level?: true; velocity?: true }` — WHICH bound set(s) `resolveCuts` fills.
 *    `level` ⇒ the evt/z/op fields (compared against `level`); `velocity` ⇒ the SEPARATE
 *    velEvt/velZ/velOp fields (compared against `delta20`). BOTH may be set: the two cut
 *    sets MERGE (the same published metrics feed both axes). At least one is required.
 *  - `ownZ: true` (R1/R5/EBP): the regime-relative z is an own-LEVEL z built from the
 *    indicator's own fetched series ⇒ `usesOwnSeriesZ`. OMIT it wherever no own-level z
 *    applies — velocity-only ids (R2/R3/R4), whose z is the delta20 velocity z computed
 *    inline in rawStateSeries. This is an EXPLICIT flag, never
 *    inferred from the axis: a level axis does NOT imply an own-level z.
 *  - `evtLevel: true` (R1/R5/EBP + R2/R3/R4): the EVT + operative legs are wired on this
 *    id's resolved axis. `false` omits them.
 *  - `evtVelocity` — the SAME gate for the VELOCITY axis (`evt_vel_*` / `operative_vel_*`),
 *    defaulting to `evtLevel`. Split out for F1 (2026-07-23 `[USER]`) when it was the only id
 *    wanting its measured velocity leg WITHOUT its measured level leg. Since the 2026-07-28
 *    velocity retune (`[USER]`) F1 sets it FALSE — both axes are hand-set registry priors — so
 *    the flag is now redundant with `evtLevel` there and is kept EXPLICIT only because the two
 *    axes were independently ruled. **F9 joined it 2026-08-07, F11 2026-08-08** in the MIRROR position
 *    (`evtLevel: false, evtVelocity: true`) when its level axis was retired: the `??` default makes a
 *    bare `evtLevel: false` close the velocity axis too, so a velocity-only id that wants its measured
 *    velocity legs must state `evtVelocity: true` rather than lean on `evtLevel: true`. Omit it
 *    everywhere else — one flag still says one thing per axis.
 *
 *  A fourth axis, `proxy: true`, once marked F1/F2 as borrowing their regime-relative z leg from
 *  the `credit/baa10y` reference distribution. Those borrowed legs were retired 2026-08-06 and the
 *  entire proxy-z path — the flag, the `CALIB_MAP.{F1,F2}` rows behind it, `usesProxyZ`,
 *  `proxyLegSeries` and every fetch/branch feeding them — was deleted the same day (Stage 5.2).
 *  F1/F2 now score their OWN series against hand-set registry priors alone and resolve no
 *  calibration cut at all (their `FOLD_POLICY` entries survive that deletion by construction).
 *
 *  - `synthPriors: true` (**F3 — the live set, now a SINGLETON**, Stage 6.2b. **F9 LEFT the seam
 *    2026-08-08** and **F11 2026-08-09**, both for the same rolling-σ z replacement
 *    — F10 REVERTED 2026-07-18 — see below): this
 *    id has NO harness vintage — its
 *    rows are computed at run time and appended by `withSynthesizedPriors`, which every
 *    `resolveCuts` call site routes through. See that function for the leg choice, the
 *    accepted boundary knife-edge and the split-brain guard.
 *
 * The DRAWN line (`effectiveCuts`) reads `legs` too: it plots the level axis unless the id
 * is velocity-ONLY (`legs.velocity && !legs.level`) — a level id's off-axis velocity leg
 * stays undrawn (design correction #2).
 *
 * Orphaned params left unmapped (reviewer N2): `rate/t10y2y_*` (no live T10Y2Y
 * indicator) and `geo/wti_*` (G1 oil STAYS
 * Tier C — `classifyDerived` is a separate no-z-leg path, Decision A, not wired).
 */
export const CALIB_MAP: Readonly<
  Record<
    string,
    {
      channel: string;
      prefix: string;
      evtLevel: boolean;
      /** Velocity-axis EVT/operative gate; defaults to `evtLevel`. Set only where the two differ (F1, F9, F11). */
      evtVelocity?: boolean;
      legs: { level?: true; velocity?: true };
      ownZ?: true;
      synthPriors?: true;
    }
  >
> = {
  // R1 ABSENT since the 2026-08-31 [USER] option-A switch to a `SMOOTHED_LEVEL_OF` carrier: the
  // `scoreWithCuts` smoothed arm throws on ANY resolved cut, so its `rate/t10y3m_*` vintage rows
  // (still published) resolve nothing, exactly as R8's. Do not re-add without wiring the legs.
  R5: { channel: "vol", prefix: "vix", evtLevel: true, legs: { level: true }, ownZ: true },
  // **`evtLevel` RETIRED for EBP (2026-07-29 `[USER]`).** Both gated legs stop resolving: the
  // `ebp_evt_level_*` GPD pair and the `ebp_operative_*` cell-sweep pair (the latter is what the
  // detail chart drew and what actually scored, being the lower of the two). The user retuned
  // EBP's level axis by hand in `registry.ts` — the single source — and a MEASURED row cannot
  // carry a hand-typed value without its `method: cell_sweep` becoming a lie; leaving the
  // measured legs ON beside the hand pair would also have left the lower measured amber binding,
  // making the retune invisible. Same mechanic, same reason as F1's two retirements below.
  // EBP's LEVEL axis is now the `op` CONVENTION leg over the registry pair — one pair, drawn and
  // scored. `ownZ` stays: the regime-z leg is NOT gated on `evtLevel` and ORs on unchanged over
  // EBP's own `ebp_zref_*` distribution.
  EBP: { channel: "credit", prefix: "ebp", evtLevel: false, legs: { level: true }, ownZ: true },
  // R6 ABSENT since the 2026-08-30 [USER] remap: the static z-leg is retired, so no `vol/move_*` lookup.
  // Unmapped ⇒ `resolveCuts` returns `{}` ⇒ `scoreMoveLevel` scores it. Do not re-add.
  // **F1 AND F2 ARE DELIBERATELY ABSENT (2026-08-06, Stage 5.2).** Their rows had already been
  // hollowed to nothing by three [USER] retirements — `evtLevel` (F1 2026-07-23, F2 always),
  // `evtVelocity` (F1 2026-07-28) and the BORROWED Baa10y proxy-z legs (both, 2026-08-06) — after
  // which every leg in `resolveCuts` was gated off and the rows resolved NO measured cut at all.
  // Stage 5.2 deleted them along with the `proxy` axis they were the only carriers of. Both ids
  // now score their OWN series against the hand-set `registry.ts` priors through the `op` (level)
  // and `vel-op` (velocity) CONVENTION legs — which need no `CALIB_MAP` entry and have always been
  // live — exactly the two-leg Red conjunction `FOLD_POLICY.{F1,F2}` rules. That fold survives this
  // deletion because it is read BEFORE the `CALIB_MAP` guard and merged into both exits.
  // ⚠ ABSENT-VINTAGE PATH: the `credit/hyoas` vintage is still REQUIRED even though F1 resolves NO
  // cut from it. `runScoringCycle`'s `assertF1VintagePresent` guard is a ROWS-PRESENT check on the
  // `credit/hyoas` prefix (2026-07-28) and THROWS on the cron SCORING path rather than degrading —
  // the frozen `calibration.json` vintage losing the `hyoas` prefix is exactly what it catches
  // loudly. It was written against a regen of the `harness.py` retired 2026-08-15; with the
  // vintage frozen, a prune or a hand-edit is now the only way the prefix goes missing. (The
  // api/series READ path keeps its own degrade: it renders `convention`/no band, not a throw.)
  // ⚠ F1's velocity SPAN is `velocityWindow: ARM_ROC_WINDOW` in `registry-fred.ts`, SHARED with the
  // ARM key (same window source, distinct semantics). `VELOCITY_WINDOW` stays 20
  // **globally and permanently** — a per-indicator override is the only sanctioned way to vary it.
  // **BAA10Y WAS DELIBERATELY ABSENT from CALIB_MAP (2026-07-23 `[USER]`; the indicator itself
  // retired outright 2026-08-11).** It resolved NO vintage cut at all: its four numbers were the
  // hand-set `BAA10Y_*` constants (since deleted with the descriptor),
  // read straight off the registry thresholds through the `op` / `vel-op` convention legs. It was
  // briefly mapped with `ownZ: true` onto `baa10y_zscore_*` over `baa10y_zref_*` (⇒ 2.169/2.289 pp,
  // above the entire post-2023 range — a dark card). THAT is the live reason the absence stands:
  // the σ-cut version put both bounds above the whole post-2023 range, so the leg never fired and
  // the card was dark. The hand-set level is also invariant to the reference distribution —
  // nothing to invert, nothing that can drift. (The absence was ALSO argued from single-sourcing a
  // pair borrowed by F1/F2; that borrow ended 2026-08-06 when the whole proxy-z path was retired,
  // so that argument is history and only the dark-card one still carries weight.) Re-adding an entry here would
  // re-open the dark-card failure, not merely add a second source.
  // **CQS is likewise absent** (2026-08-06): its pair is hand-set in `CQS_DESCRIPTOR` and there is
  // no published vintage for a Baa−Aaa difference to resolve.
  // Velocity-only ids (qimpag 2026-06-30 P3-follow): the harness references their EVT/z
  // cut on the 20-day change, so resolveCuts routes them into the SEPARATE velocity bound
  // set (vel*) compared against `delta20`, NOT `level`. `evtLevel: true` = the velocity
  // EVT leg is wired (velEvt*). No `ownZ`: their z is the delta20 velocity z computed
  // inline in rawStateSeries, so `usesOwnSeriesZ` must stay false (no spurious level z).
  R2: { channel: "rate", prefix: "dgs10", evtLevel: true, legs: { velocity: true } },
  R3: { channel: "rate", prefix: "dgs2", evtLevel: true, legs: { velocity: true } },
  R4: { channel: "rate", prefix: "dfii10", evtLevel: true, legs: { velocity: true } },
  // --- Runtime-synthesized ids (Stage 6.2b) — `synthPriors`, no harness vintage ------
  // F3 carries BOTH a level and a velocity axis (F9 and F11 did until their level axes were retired
  // 2026-08-07 and 2026-08-08 — see their entries) and NO published calibration
  // row: their cuts are computed at RUN time and injected as synthesized param rows by
  // `withSynthesizedPriors` (below), which every `resolveCuts` call site must route
  // through. In 6.2b the injected value IS the registry prior (values unchanged); 6.3
  // swaps it for the point-in-time expanding percentile. NO `ownZ` — Option B uses no z
  // leg at all for these ids, so `usesOwnSeriesZ` stays FALSE and `scorers.ownSeriesZ`
  // never builds a spurious own-level z. The `(channel, prefix)` pairs are PRIVATE to the
  // synth path — deliberately distinct from every harness-emitted prefix, so a future
  // published vintage can never silently collide with a synthesized row.
  //
  // ⚠ **F10 IS DELIBERATELY ABSENT (2026-07-18, option-C ruling).** 6.3 put F10 live on
  // computed 2.38/2.64 against its registry priors 3.5/4.5 — an ESCALATION, off the same
  // server-truncated ICE BofA feed: keyless FRED serves
  // `BAMLEMCBPIOAS` over a rolling ~3-year window only, so its
  // empirical 85/95 is fitted to one benign credit regime containing no event, and
  // `PCT_MIN_OBS` cannot catch that (a depth floor never certifies that the window spans
  // the tail). F10 is REVERTED to its hand-typed registry priors, and it is removed from
  // this map ENTIRELY rather than kept with `synthPriors` dropped: `credit/emcbpioas` is a
  // synth-PRIVATE prefix no harness publishes, so a surviving entry would be a lookup that
  // can never resolve — dead config plus a latent collision trap. Unmapped ⇒ `resolveCuts`
  // returns `{}` ⇒ `classify` falls back to the registry thresholds, which is exactly how
  // the remaining hand-typed ids (DISP) reach the notify path. (R6 left this map
  // 2026-08-30 with its static z-leg — `scoreMoveLevel` scores it. DISP stays hand-typed BY RULING, not by omission:
  // W3 ruled its 0.55/0.70 cuts are pre-measured dwell boundaries, and putting DISP on this
  // seam would re-cut its RED against its own history. Do not "fix" that.)
  //
  // **F3 joined the seam 2026-07-20 (W1 slice 2); its velocity leg opened 2026-07-21 (R2).**
  // Its registry prior 0.5/1.0 is a DEAD level cut: `NFCIRISK` regime-shifted, its post-2010
  // maximum is 0.136 (2020-04-03) — the March-2020 crash did not reach a quarter of the
  // amber cut — so F3 was structurally incapable of leaving GREEN, a permanently silent
  // FIN-channel input. Measured over F3's stored `EXPANDING_PERCENTILE_PREFIX_YEARS` window (its registry `backfill` depth) the expanding
  // percentile puts amber/red at ≈ -0.338 / -0.171, which the 2020 peak clears outright, so
  // the indicator can signal again. Two properties differ from F9/F11 and are
  // load-bearing (and since 2026-08-08 F3 is the ONLY `synthPriors` id with a level axis at all):
  //  - **DUAL-LEG, but AMBER-ONLY on velocity** (`legs: { level: true, velocity: true }`; the
  //    registry prior defines `amberVelocity` but NO `redVelocity`): `synthAxesFor` opens the
  //    velocity axis, `withSynthesizedPriors` emits `evt_vel_amber`/`operative_vel_amber` and
  //    `resolveCuts` opens a velocity leg that can only vote AMBER — the RED velocity row is
  //    never emitted (`computeSynthCutsDetailed` gates each leg on its own prior) and
  //    `resolveCuts`'s `velEvtRed`/`velOpRed` do NOT fall back to the LEVEL red row for a
  //    level-bearing id. `dashboard.synth-cuts.test.ts` pins the axis agreement for every synth id.
  //  - **Weekly cadence + a 4-WEEK velocity window** (`velocityWindow: 4`): the percentile
  //    machinery is OBSERVATION-indexed, never calendar-indexed, so a weekly series is not a
  //    special case for the LEVEL cut — `EXPANDING_PERCENTILE_PREFIX_YEARS` of weekly NFCI releases (~52/yr) lands past
  //    `PCT_MIN_OBS` (252). For VELOCITY the default `SYNTH_VEL_WINDOW` (20) would mean 20 WEEKS;
  //    `velocityWindow: 4` (threaded into `computeSynthCutsDetailed`) makes both the scored
  //    `delta20` and the synth cut a 4-WEEK |Δ|, so the trap the level-only comment once warned
  //    about is now resolved rather than merely unreachable.
  //
  // ⚠ **F3's degrade path is a DEAD cut, not a conservative one.** For F9/F11 an
  // unavailable history degrades to a VELOCITY prior that still fires; for F3 it degrades to 0.5/1.0
  // (+ amberVelocity 0.5), i.e. **silently back to permanently GREEN** — the exact defect this
  // entry fixes, re-armed with no error and (since the `/api` `provenance` field was retired
  // 2026-07-30) nothing on screen to hint at it. So an F3 history gap is not "fail-safe", it is
  // the indicator switching itself off.
  F3: { channel: "credit", prefix: "nfcirisk", evtLevel: true, legs: { level: true, velocity: true }, synthPriors: true },
  // ⚠ **F9 is VELOCITY-ONLY since 2026-08-07** (user ruling)
  // — `legs: { velocity: true }`, the same shape R2/R3/R4 carry above. Its level axis
  // was retired outright as a trend read, not a danger read (rationale + the measured base rates live
  // in F9's `registry.ts` block, the one source). Dropping `legs.level` is the OTHER half of the kill
  // switch: the registry edit closes `synthAxesFor`'s level axis so no `evt_level_*`/`operative_*` row
  // is ever emitted, and this drops the bound set that would read one.
  //
  // ⚠ **F9 LEFT `synthPriors` 2026-08-08** (`[USER]`
  // ruling) and is therefore no longer a `SYNTH_PRIOR_IDS` member. Its velocity cut is no
  // longer a runtime expanding-percentile fit over |Δ60| — a percentile is what you reach for when the
  // raw scale drifts, and the fix ruled instead was to remove the drift: F9 STANDARDIZES first
  // (`thresholds.velocitySigma` in `registry.ts` ⇒ `z = Δ60 / σ`, σ strictly historical, built by
  // `velocitySigmaZSeries`) and cuts at fixed σ values. Those live on the registry pair and reach the
  // scorer through `legBounds`' `vel-z` leg. So for F9 this row now resolves NO cut at all, and that
  // is the intended state, not a degrade: **no vintage publishes an `fx/dtwexbgs_*` row** (F9 is not
  // in the swept harness set, and the only emitter it ever had was `withSynthesizedPriors`), so
  // `resolveCuts("F9", …)` returns an empty cut set and the σ pair is unopposed.
  //
  // ⚠ **THE HAZARD THIS ROW NOW CARRIES — and its exact shape.** Every velocity bound below is in
  // the SERIES' OWN units, while F9's scored velocity quantity is a z. The two publishable row
  // families are NOT equally dangerous, and conflating them once sent this note chasing the wrong
  // one:
  //   - `fx/dtwexbgs_zscore_amber/_red` ⇒ `velZAmber/velZRed` ⇒ lands on the SAME `vel-z` leg the
  //     σ pair backs, compared against the day's z. A raw-unit number there means index points vs
  //     σ — the real UNITS MISMATCH. `legBounds` (domain-legs.ts) now THROWS on that combination
  //     rather than letting `velZCut ??` silently dominate the convention pair.
  //   - `fx/dtwexbgs_evt_vel_*` / `_operative_vel_*` ⇒ `vel-evt` / `vel-op`, both compared against
  //     the RAW `delta20`, which is the correct unit for them. Publishing one is still a decision
  //     (it opens an EXTRA OR-leg that can escalate a day the σ leg would have left GREEN), but it
  //     is not a unit error and the gate deliberately does not block it.
  // `evtLevel: false` + the explicit `evtVelocity: true` is kept exactly as ruled
  // 2026-08-07 (a bare `evtLevel: false` would close the velocity EVT/operative bound set too, since
  // `evtVel` derives as `map.evtVelocity ?? map.evtLevel`; F1 is the precedent for splitting the two)
  // — inert today with nothing to resolve, but it is the shape the hazard above would land in.
  F9: { channel: "fx", prefix: "dtwexbgs", evtLevel: false, evtVelocity: true, legs: { velocity: true } },
  // ⚠ **F11 is VELOCITY-ONLY since 2026-08-08** (user rulings)
  // — the same shape F9 took above, one day earlier, for the same defect class. Its level
  // axis was retired outright as a PEG-REGIME / managed-float state read, not a danger read (rationale +
  // the measured base rates live in F11's `registry.ts` block, the one source). Dropping `legs.level` is
  // the OTHER half of the kill switch: the registry edit closes `synthAxesFor`'s level axis so no
  // `evt_level_*`/`operative_*` row is ever emitted, and this drops the bound set that would read one.
  //
  // ⚠ **`evtLevel: false` MUST be paired with an explicit `evtVelocity: true`** — identical trap to F9's,
  // and it is the `??` default (`evtVel = map.evtVelocity ?? map.evtLevel`) that sets it. The four emitted
  // rows are `dexchus_evt_vel_amber/red` + `dexchus_operative_vel_amber/red` (no level row, the registry
  // pair is gone); what differs across the three shapes is how many of the four velocity BOUNDS come back.
  //
  // ⚠ **F11 LEFT THE SYNTH SEAM 2026-08-09**: its
  // `synthPriors` is gone, so `withSynthesizedPriors` emits NOTHING for F11 on either axis and the
  // whole four-row table below is a description of the seam's SHAPE, not of live F11 rows. The velocity
  // cut is now a fixed σ pair on the registry (`velocitySigma` + `amberVelocity`/`redVelocity` read as
  // multiples), exactly as F9's is. ⛔ Re-adding `synthPriors` here would resolve raw-POINTS percentile
  // rows that DOMINATE the σ pair — silently comparing CNY-per-USD points to σ.
  // NO NUMBERS HERE ON PURPOSE — the shape below is the seam's, not a live F11 cut
  // (`indicator-loop.md` §a retune is a ONE-place edit):
  //   `evtLevel: true`                      ⇒ all four velocity bounds resolve (velEvt{Amber,Red} + velOp{Amber,Red})
  //   `evtLevel: false`                     ⇒ `{}` — NOTHING resolves        ← the trap
  //   `evtLevel: false, evtVelocity: true`  ⇒ the same four, at the same values as row 1
  // Rows 1 and 3 are value-identical; row 2 differs by resolving an EMPTY cut set, whereupon `legBounds`
  // falls the velocity leg back to the registry convention pair (0.05/0.12) — which sits BELOW F11's
  // measured percentile, i.e. a silent ESCALATION on the notify path. The shipped shape is the third.
  //
  // With `legs.level` false the `?? look("evt_level_*")` fallback arm under `velEvtAmber` becomes
  // REACHABLE for F11 for the first time. It stays dark because no level row is emitted either — pinned
  // by `registry.test.ts`'s emission-half test, not asserted in this comment.
  F11: { channel: "fx", prefix: "dexchus", evtLevel: false, evtVelocity: true, legs: { velocity: true } },
};

/**
 * A structurally-typed calibration param row — the shape `resolveCuts` reads and the
 * shape `withSynthesizedPriors` emits. Deliberately loose (no `ciLow`/`ciHigh`/
 * `computedAt`): `store.CalibrationParam` is assignable to it, and the `domain-*.ts` split stays a
 * store-free DAG root (no store import — reviewer C2).
 */
export interface CalibParamRow {
  channel: string;
  metric: string;
  value: number;
  market?: string | null;
  mode?: string | null;
}

/**
 * THE injection seam for runtime-computed cuts (Stage 6.2b, Option B): append one
 * indicator's synthesized `(channel, metric, value)` rows to a `getCalibration()` vintage
 * so `resolveCuts` resolves them exactly as if the harness had published them. Ids without
 * `synthPriors` pass `params` through untouched (referential identity), so every existing
 * id — and every unmapped one — is byte-unaffected.
 *
 * ⚠ **SPLIT-BRAIN GUARD — load-bearing.** Four call sites each resolve against their OWN
 * `getCalibration()`: `run-cycle-fred.ts` (the F3 fast-confirmer path), `confirmers.ts` (`scoreWithCuts` → the F9/F11
 * FRED loop), `api/series.ts` (`recomputedSeries`) and `api/indicators.ts`
 * (`provenance`). Synthesizing at only one of them makes `/lab`
 * report `convention` while the notify path fires `measured`. Route ALL of them through
 * THIS function; `api/indicators.test.ts` pins the notify/`/api/indicators` agreement.
 *
 * **Leg choice — `evt_*` AND `operative_*` (W1, 2026-07-20).** Through Stage 6.3 this helper
 * emitted ONLY the `evt_*` rows, on the reasoning that an 85th/95th empirical CDF is an EVT
 * cut and the leg identity had to stay stable across the 6.2→6.3 migration. That left the
 * `op` leg on its **registry convention fallback** (`legBounds`: `op ?? t.amberLevel`), and
 * because `classify` ORs the legs, **the hand-typed prior stayed live as an independent leg
 * that the measured cut can only ever tighten, never loosen.** F9's LEVEL axis was the shipped
 * instance: its measured level cuts were 121.15/124.11 (`scripts/backtest/synth_cuts.json`) but the
 * convention `op` leg at 106/110 fired on every close since 2018 — `DTWEXBGS` drifted permanently past
 * a prior authored for a ~100-centred index, and the seam built to fix exactly that was structurally
 * unable to. (**That axis no longer exists**: F9 is velocity-only since 2026-08-07 — the displacement
 * fix made the cut correct but could not make a level read on a trending index informative. See F9's
 * `CALIB_MAP` entry above. The numbers here are history and cannot rot.) The same defect ran on the
 * velocity axis, which DOES survive, and the displacement is what fixed it there.
 *
 * So the synth cut now occupies BOTH legs on BOTH axes: a present `operative_*` cut REPLACES
 * the convention leg for that band (② Decision 2, the same mechanic R1/R5/EBP get from their
 * published harness rows), so a `synthPriors` id's registry `thresholds` become what they are
 * documented to be — the **degrade fallback** (`computeSynthCutsDetailed`), not a parallel
 * live cut. The `op` and `evt` legs then carry the identical value and are redundant by
 * construction; that redundancy is the price of reusing the existing displacement mechanic
 * rather than threading an id through `classify`/`winningLeg`/`effectiveCuts`.
 *
 * ⚠ This is a live-band change in the **de-escalating** direction for any id whose measured
 * cut sits ABOVE its prior: F9's surviving VELOCITY axis is the live case (its retired level axis was
 * the other half until 2026-08-07).
 * F11's surviving VELOCITY axis is the other
 * live case — its measured cuts sit ABOVE the prior (0.10184/0.1744 vs 0.05/0.12), so it de-escalates
 * exactly as F9's does. (F11's LEVEL axis was the counter-example until it was retired 2026-08-08: its
 * measured cuts sat BELOW the prior, so the `evt` leg already dominated and the seam could only ever
 * LOOSEN an axis already elevated on ~40% of recent days — one of the reasons that axis is gone. History,
 * and it cannot rot.)
 *
 * **The 2026-07-17 knife-edge is dissolved for these ids, not coded around.** It existed
 * because a measured `evt` leg compares INCLUSIVE (`level >= b`) while the `op` leg's
 * convention fallback is STRICT (`level > b`), so injecting the prior flipped the band at
 * EXACTLY the cut (`(level > b) || (level >= b)` ≡ `level >= b`, at the resolved level cut `b`). With the convention
 * fallback displaced there is no strict leg left to disagree with: both legs are measured and
 * inclusive at the same value. The knife-edge remains the live semantics for every
 * NON-`synthPriors` id that resolves an `evt` cut without an `operative_*` row.
 *
 * **The velocity axis got its OWN values in Stage 6.3.** Through 6.2b `legs:{level,velocity}`
 * merged both cut sets off the SAME metric names, so the level prior also landed on `velEvt*`
 * (compared against `delta20`) and was inert by DOMINATION — every level prior is far larger
 * than its own velocity convention (F11's retired 7.2 against its 0.05/0.12 velocity pair, and F9's
 * retired 106 against its own, were the two instances), so `delta20 >= levelCut` implied the convention leg had already
 * fired. 6.3 dissolves that: this helper now emits SEPARATE `evt_vel_*` rows carried by
 * `thresholds.amberVelocity`/`redVelocity`, and `resolveCuts` prefers them on the velocity
 * axis. The velocity legs are therefore LIVE, at the same fail-safe knife-edge as the level
 * legs (`(d20 > b) || (d20 >= b)` ≡ `d20 >= b` at the resolved velocity cut `b`).
 *
 * **Double-scaling is dissolved by construction (Stage 6.3).** This function is value-blind:
 * it emits whatever `thresholds` it is handed. Its ONE production caller — `synthesizedCalib`
 * (`synth-cuts.ts`) — hands it either (a) expanding-percentile cuts computed from the RAW
 * stored series, a statistic that has never seen the earliness multiplier `m`, or (b) the
 * degraded fallback `indicator.rawThresholds ?? indicator.thresholds`, i.e. the PRE-multiplier
 * registry priors. Either way `scaleCuts`' single application of `m` inside `resolveCuts` is
 * the only one, so the `m !== 1` double-scale that 6.2b documented as a latent wart cannot
 * occur. (Through 6.2b callers passed the already-`m`-scaled `indicator.thresholds` directly.)
 */
export function withSynthesizedPriors(
  indicatorId: string,
  thresholds: Thresholds,
  params: ReadonlyArray<CalibParamRow>,
): ReadonlyArray<CalibParamRow> {
  const map = CALIB_MAP[indicatorId];
  if (map?.synthPriors !== true) return params;
  // Legacy shared rows (market/mode null): `resolveCuts`' cell-less notify path reads ONLY
  // these, and its per-cell path falls back to them per metric — so ONE row set serves both
  // and a cell can never diverge from the notify band on a synthesized cut.
  const row = (suffix: string, value: number | undefined): CalibParamRow[] =>
    value === undefined
      ? []
      : [{ market: null, mode: null, channel: map.channel, metric: `${map.prefix}_${suffix}`, value }];
  return [
    ...params,
    ...row("evt_level_amber", thresholds.amberLevel),
    ...row("evt_level_red", thresholds.redLevel),
    // Stage 6.3 — the velocity axis's OWN cut (85th/95th of |Δ20|), read by `resolveCuts`'
    // `velEvt*` legs in preference to `evt_level_*`. A distinct metric name, so a future
    // published vintage for a velocity-only id can never collide with it.
    ...row("evt_vel_amber", thresholds.amberVelocity),
    ...row("evt_vel_red", thresholds.redVelocity),
    // W1 (2026-07-20) — the SAME values on the operative leg, so the registry prior's
    // convention fallback is displaced instead of surviving as a parallel OR-leg the
    // measured cut can only tighten. `operative_vel_*` is a distinct metric for the same
    // reason `evt_vel_*` is: `resolveCuts`' velocity leg otherwise falls back to the
    // LEVEL-named `operative_amber` and a dual-axis id's velocity leg goes inert by
    // domination (Stage 6.2b's finding, re-run on the op axis).
    ...row("operative_amber", thresholds.amberLevel),
    ...row("operative_red", thresholds.redLevel),
    ...row("operative_vel_amber", thresholds.amberVelocity),
    ...row("operative_vel_red", thresholds.redVelocity),
  ];
}

/**
 * Does this indicator's cut set come from the runtime synth seam (`synthPriors`) rather
 * than a published harness vintage? The one exported predicate over that flag — the
 * history loader (`synth-cuts.ts`) and every `resolveCuts` call site key off it, so
 * `CALIB_MAP` stays private.
 */
export function hasSynthPriors(indicatorId: string): boolean {
  return CALIB_MAP[indicatorId]?.synthPriors === true;
}

/** The `synthPriors` ids, in `CALIB_MAP` order — the exact set the history loader reads. */
export const SYNTH_PRIOR_IDS: readonly string[] = Object.keys(CALIB_MAP).filter(hasSynthPriors);

/**
 * Which cut axes `resolveCuts` will actually OPEN for this id — the read side of the
 * agreement `synthAxesFor` (`synth-cuts.ts`) derives from the registry prior.
 *
 * Exported so a test can PIN that agreement instead of asserting it in a docblock. The
 * unsafe direction is real: `legs: { velocity: true }` against a level-only prior makes the
 * synth path emit no `evt_vel_*` rows while `resolveCuts` still opens the velocity legs —
 * they resolve to nothing and the velocity band silently WIDENS, exactly the failure
 * `synth-cuts.ts`' header rules out. `CALIB_MAP` itself stays private.
 */
export function calibLegsFor(indicatorId: string): { level: boolean; velocity: boolean } {
  const legs = CALIB_MAP[indicatorId]?.legs;
  return { level: legs?.level === true, velocity: legs?.velocity === true };
}

/**
 * Resolve one indicator's measured cut-points from a `getCalibration()` vintage.
 * Pure, structurally typed over the param shape so the `domain-*.ts` split stays a
 * store-free DAG root (no `store.CalibrationParam` import — reviewer C2).
 * An unmapped indicator or an absent row yields `undefined` for that leg ⇒ the leg
 * is skipped downstream (fail-safe by construction). For proxy indicators
 * (`evtLevel: false`) the EVT-level cuts are deliberately omitted even when present.
 */
/**
 * THE ONE cuts→cuts earliness transform (Fix 2 dedup — single source): scale every measured
 * cut leg of a `CalibrationCuts` by `m` through the direction-normalized `earlierCut`, carrying
 * the zref DISTRIBUTION (`zrefMean`/`zrefStd`/`velZref*`) through UNTOUCHED (the spread carries
 * it). Level EVT/operative legs flip earliness with `levelHighward` (a LOW-polarity level moves
 * UP toward danger); every velocity leg and every z-cut is highward (σ-space folds direction in).
 * `m === 1` is the identity (byte-parity for the shipped all-1.0 config). Consumed by BOTH
 * `resolveCuts`'s decoration path (the config multiplier) and api/series' `?mult` what-if
 * (`applyMult`), so the 12-leg direction table lives in exactly ONE place and the two can't drift.
 */
export function scaleCuts(cuts: CalibrationCuts, levelHighward: boolean, m: number): CalibrationCuts {
  return {
    ...cuts,
    evtAmber: earlierCutOpt(cuts.evtAmber, levelHighward, m),
    evtRed: earlierCutOpt(cuts.evtRed, levelHighward, m),
    zAmber: earlierCutOpt(cuts.zAmber, true, m),
    zRed: earlierCutOpt(cuts.zRed, true, m),
    opAmber: earlierCutOpt(cuts.opAmber, levelHighward, m),
    opRed: earlierCutOpt(cuts.opRed, levelHighward, m),
    velEvtAmber: earlierCutOpt(cuts.velEvtAmber, true, m),
    velEvtRed: earlierCutOpt(cuts.velEvtRed, true, m),
    velZAmber: earlierCutOpt(cuts.velZAmber, true, m),
    velZRed: earlierCutOpt(cuts.velZRed, true, m),
    velOpAmber: earlierCutOpt(cuts.velOpAmber, true, m),
    velOpRed: earlierCutOpt(cuts.velOpRed, true, m),
  };
}

export function resolveCuts(
  indicatorId: string,
  params: ReadonlyArray<{
    channel: string;
    metric: string;
    value: number;
    market?: string | null;
    mode?: string | null;
  }>,
  direction: Direction,
  config?: ThresholdConfig,
): CalibrationCuts {
  // Read BEFORE the CALIB_MAP guard and merged into BOTH exits: the fold is not a calibration
  // cut, so an id carrying a policy but no calibration entry must still get its policy.
  const fold = FOLD_POLICY[indicatorId];
  const map = CALIB_MAP[indicatorId];
  if (!map) return fold ? { fold } : {};
  // Engine-wide earliness multiplier (config seam): m<1 fires EARLIER, m>1 later. Applied
  // to every measured cut leg via `scaleCuts` so it reaches the notify path (run-dbfirst.ts) with zero
  // opt-in. `config` is injectable (defaults to the global threshold-config.json via
  // resolveMultiplier's own default) so tests can drive a non-1.0 multiplier through THIS real
  // seam — mirrors resolveBands' injectable config.
  const m = resolveMultiplier(indicatorId, config);
  // The velocity axis's EVT/operative gate — `evtLevel` unless the id splits the two (F1).
  const evtVel = map.evtVelocity ?? map.evtLevel;
  const levelHighward = direction !== "LOW";
  // The resolver is target-blind by construction: it reads ONLY legacy shared
  // (market, mode) = (null, null) rows, so a per-cell vintage in prod's `calibration`
  // table can never leak a mode-specific cut onto the notify path via unspecified row
  // order. Loose == matches null AND undefined, so structurally-typed callers without the
  // fields (tests, pre-migration vintages) resolve unchanged.
  const look = (suffix: string): number | undefined =>
    params.find(
      (p) =>
        p.market == null && p.mode == null && p.channel === map.channel && p.metric === `${map.prefix}_${suffix}`,
    )?.value;
  // Velocity-only ids (R2/R3/R4): route the SAME published metrics into the velocity
  // bound set so classify compares them against `delta20`, not `level` (qimpag P3-follow).
  // Operative cuts (② Decision 2) are gated on `evtLevel` like the EVT legs — an id whose
  // published rows are not in its own units must never let one replace its own-units absolute.
  // Build the RAW (unscaled) cut set, then apply the ONE shared earliness transform. The zref
  // distribution fields ride through `scaleCuts` untouched (spread).
  // `legs` MERGES rather than early-returning on one axis (Stage 6.2a): an id may carry
  // BOTH a level and a velocity axis, and the same published metrics then feed both bound
  // sets. For a single-axis id the merge yields exactly the one set, byte-identical to the
  // old either/or routing.
  const scaled = scaleCuts(
    {
      ...(map.legs.level
        ? {
            evtAmber: map.evtLevel ? look("evt_level_amber") : undefined,
            evtRed: map.evtLevel ? look("evt_level_red") : undefined,
            // The regime-relative z leg, always over the id's OWN published `zref` distribution.
            // (F1/F2 once BORROWED this leg off `credit/baa10y`; that borrow was retired and the
            // whole proxy-z path deleted 2026-08-06 — Stage 5.2.)
            zAmber: look("zscore_amber"),
            zRed: look("zscore_red"),
            zrefMean: look("zref_mean"),
            zrefStd: look("zref_std"),
            opAmber: map.evtLevel ? look("operative_amber") : undefined,
            opRed: map.evtLevel ? look("operative_red") : undefined,
          }
        : {}),
      ...(map.legs.velocity
        ? {
            // Stage 6.3: an id carrying BOTH axes gets its own velocity-axis rows
            // (`evt_vel_*`, the 85th/95th of |Δ20|). The `evt_level_*` fallback is what
            // the velocity-ONLY harness ids (R2/R3/R4) have always read — they publish no
            // `evt_vel_*` row, so their routing is byte-identical. Without the distinct
            // metric the merged `legs:{level,velocity}` ids feed BOTH axes off the level
            // cut and the velocity leg is inert by domination (Stage 6.2b's finding).
            // The LEVEL-named fallback (`evt_level_*`/`operative_*`) exists ONLY for the
            // velocity-ONLY harness ids (R2/R3/R4), which publish no `evt_vel_*`/`operative_vel_*`
            // row and read the level row as their velocity cut. For a LEVEL-BEARING id
            // (`map.legs.level`) that fallback is WRONG — it would feed the velocity leg off the
            // level cut, and for an AMBER-ONLY velocity id (F3, R2: no `redVelocity` prior, so no
            // `evt_vel_red` row) it would silently raise a Red velocity vote off the level red row.
            // So gate the fallback on `!map.legs.level`. Byte-identical for R2/R3/R4 (level leg
            // absent ⇒ fallback stays live) and for F3 (level-bearing ⇒ fallback gated off).
            // ⚠ **F9 changed side 2026-08-07 and F11 2026-08-08** when their level axes were retired:
            // both are now
            // level-ABSENT, so this fallback arm is REACHABLE for them for the first time. It stays
            // dark only because `withSynthesizedPriors` emits no `evt_level_*`/`operative_*` row
            // for them either (their registry priors define no level pair, so `synthAxesFor` closes
            // that axis). That is a two-file coincidence, not a local invariant — and the pin is
            // NOT the leg-inventory assertion, which is value-blind and would stay green if the
            // velocity leg silently took a level-units cut. The EMISSION is pinned by
            // `registry.test.ts` §"F9 velocity-only …" / §"F11 velocity-only …" → the tests
            // "withSynthesizedPriors emits NO level-named row", which drive the real seam and assert
            // no emitted metric matches `/evt_level|operative_(amber|red)/`.
            velEvtAmber: evtVel
              ? (look("evt_vel_amber") ?? (map.legs.level ? undefined : look("evt_level_amber")))
              : undefined,
            velEvtRed: evtVel
              ? (look("evt_vel_red") ?? (map.legs.level ? undefined : look("evt_level_red")))
              : undefined,
            // The velocity twin of the `z` leg above — the published σ-cut over the id's own
            // `zref` distribution. (Its F1/F2 proxy variant died with the level twin, 2026-08-06.)
            velZAmber: look("zscore_amber"),
            velZRed: look("zscore_red"),
            velZrefMean: look("zref_mean"),
            velZrefStd: look("zref_std"),
            velOpAmber: evtVel
              ? (look("operative_vel_amber") ?? (map.legs.level ? undefined : look("operative_amber")))
              : undefined,
            velOpRed: evtVel
              ? (look("operative_vel_red") ?? (map.legs.level ? undefined : look("operative_red")))
              : undefined,
          }
        : {}),
    },
    levelHighward,
    m,
  );
  // Merged OUTSIDE `scaleCuts` on purpose — the fold is a combinator, not a scalable cut.
  return { ...(fold ? { fold } : {}), ...scaled };
}

/**
 * Point-in-time regime-relative z from the harness's published reference
 * distribution (Decision 4): `z = (today − mean) / std`, computed off only the
 * latest fetched value — NO stored history. `std ≤ 0` or a missing reference ⇒
 * `undefined` ⇒ the z-leg is skipped (absolute backstop only).
 */
export function calibratedZ(today: number, mean?: number, std?: number): number | undefined {
  if (mean === undefined || std === undefined || std <= 0) return undefined;
  return (today - mean) / std;
}

/**
 * Whether an indicator's regime-relative z-leg is computed from its OWN fetched
 * series — the explicit `ownZ` flag. True for R5/EBP (own-series EVT+z).
 *
 * FALSE has TWO distinct mechanisms, and the lookup collapses them deliberately:
 *  - a `CALIB_MAP` entry that simply does not set `ownZ` — velocity-only ids (R2/R3/R4), whose z
 *    is the delta20 velocity z computed inline in `rawStateSeries`, NOT an own-LEVEL z;
 *  - NO `CALIB_MAP` ENTRY AT ALL (`?.` short-circuits) — G1 oil, BAA10Y, **since Stage 5.2
 *    (2026-08-06) F1/F2**, whose entries were deleted with the proxy-z path, and since 2026-08-31
 *    R1 (a smoothed carrier, its row deleted with the daily-close path). ⚠ F1/F2 read false
 *    here because the ENTRY IS ABSENT, no longer because a `proxy` flag suppressed an unset
 *    `ownZ` — the old borrowed-units rationale (their z keying off `credit/baa10y`) describes a
 *    path that no longer exists.
 * Either way the live scorer (`scorers-core.ts`) builds the per-day own-series z ONLY where this
 * returns true, so no id can have a foreign reference distribution applied to its own units.
 */
export function usesOwnSeriesZ(indicatorId: string): boolean {
  // The EXPLICIT `ownZ` flag, never inferred from the axis (Stage 6.2a). This used to read
  // `evtLevel && !velocity && !proxy` — inferring "no own-level z" from the velocity axis.
  // That inference breaks for an id carrying a real level axis AND a velocity one: it would
  // flip TRUE and make scorers.ownSeriesZ build a spurious own-LEVEL z. Set `ownZ` only
  // where the indicator's own fetched series backs the z (R5/EBP).
  return CALIB_MAP[indicatorId]?.ownZ === true;
}

