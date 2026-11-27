import { expect, test, describe } from "vitest";
import { earlierCut } from "./threshold-config.js";
import {
  scoreIndicator,
  meanLevelCutSeries,
  smoothedLevelReadingSeries,
} from "./scorers-core.js";
import {
  resolveCuts,
  calibLegsFor,
  hasSynthPriors,
  SYNTH_PRIOR_IDS,
  usesOwnSeriesZ,
  calibratedZ,
} from "./domain-cuts.js";
import { withMultipliedThresholds } from "./registry-fred.js";
import { type Indicator, type Observation } from "./domain-types.js";
import { scoreWithCuts } from "./confirmers.js";
import {
  computeSynthCuts,
  computeSynthCutsDetailed,
  synthCutsDegraded,
  synthesizedCalib,
  priorThresholds,
  synthAxesFor,
  loadSynthHistories,
  loadSynthHistoriesDated,
  synthHistoriesInclusive,
  SYNTH_HISTORY_LIMIT,
  SYNTH_AMBER_PCTILE,
  SYNTH_RED_PCTILE,
  SYNTH_VEL_WINDOW,
} from "./synth-cuts.js";
import { expandingPercentile, PCT_MIN_OBS } from "./slow.js";
import { INTRADAY_CUTOFF_UTC_MIN } from "./intraday.js";
import SYNTH_GOLDEN from "../scripts/backtest/synth_cuts.json" with { type: "json" };
import { N, flat, byId } from "./dashboard.test-helpers.js";

describe("calibratedZ (point-in-time z from published reference)", () => {
  test("missing reference or std ≤ 0 ⇒ undefined (z-leg skipped)", () => {
    expect(calibratedZ(10, undefined, 2)).toBeUndefined();
    expect(calibratedZ(10, 4, undefined)).toBeUndefined();
    expect(calibratedZ(10, 4, 0)).toBeUndefined();
    expect(calibratedZ(10, 4, -1)).toBeUndefined();
  });
});

describe("Stage 6.2b - the accepted boundary knife-edge on the NOTIFY path (F11)", () => {
  // The USER-ruled trade: routing the priors through the calibration seam flips the band at
  // EXACTLY the cut, because a measured `evt` leg compares INCLUSIVE (`level >= b`) where the
  // `op` leg's convention fallback is STRICT (`level > b`). Net: `(l > b) || (l >= b)` ≡ `l >= b`.
  // It is fail-safe BY DIRECTION — at the cut the state fires EARLIER, never later.
  //
  // Driven through `scoreWithCuts` (src/confirmers.ts) — the REAL notify entry for the
  // INDICATORS FRED loop (F9/F11) — so a reverted call site fails HERE, not just in a
  // resolveCuts unit test. `flat()` holds a constant, so delta20 = 0 and no velocity leg can
  // contaminate the level attribution.
  const score = (ind: Indicator, value: number) =>
    scoreWithCuts(ind, flat(value), []).state; // [] = empty vintage; the rows are synthesized

  // Each id at its AMBER boundary + the RED boundary. The boundaries are READ OFF the registry
  // (`bounds` below), never re-typed here: a retune of any prior must not require a test edit —
  // what is pinned is the knife-edge BEHAVIOUR at whatever the cut currently is. F10 EM OAS was a
  // case here until 2026-07-18: it left the synth seam entirely (option C, truncated ICE BofA
  // feed), so it now scores on the STRICT convention compare — pinned by the "registry HIGH-level
  // edges" describe in dashboard.score-indicator.test.ts and by the F10-revert test in the Stage 6.3 block.
  // ⚠ **F9 LEFT `CASES` 2026-08-07 AND F11 2026-08-08** — this list is the LEVEL knife-edge, and both
  // ids' level axes were retired (Stage 1 of each scorer
  // redesign), so neither has an `amberLevel`/
  // `redLevel` for `bounds()` to read. **F3 is the successor carrier** and the ONLY `synthPriors` id
  // left at all (`CALIB_MAP` live set: F3), so this list cannot shrink again without the whole
  // describe going away.
  // ⚠ Non-vacuity does NOT come from the cut being measured — `flat()` supplies N=30 rows against
  // `PCT_MIN_OBS = 252`, so `computeSynthCuts` degrades to the registry prior on every call here, and
  // `domain-cuts.ts` warns "F3's degrade path is a DEAD cut, not a conservative one" (0.5/1.0 on a
  // series whose post-2010 max is 0.136). It comes from the synthesised input: `bounds()`
  // reads the REGISTRY pair (0.5/1.0) and only needs `amber > 0` / `red > amber`; the test then
  // SYNTHESISES its own input at that level, so the fact that the live NFCIRISK series never reaches
  // 0.5 does not make these assertions vacuous — `scoreWithCuts` is driven at the boundary directly.
  const CASES = ["F3"] as const;
  /**
   * The VELOCITY-axis half — the ids that still ride the SYNTH seam on the velocity axis.
   * F9 and F11 both left `SYNTH_PRIOR_IDS` outright for a fixed σ pair on the registry
   * (`thresholds.velocitySigma`) reaching the scorer through `legBounds`' `vel-z` leg — pinned in
   * `registry.test.ts`, not here. ⚠ F3 declares no `redVelocity`, so the velocity-RED assertions
   * below read undefined against undefined and are DARK until an id with one joins the seam.
   */
  const VEL_CASES = ["F3"] as const;
  const indFor = (id: string) => byId(id);
  /** Registry cuts + a value strictly below the amber cut, derived so a retune carries them along.
   *  `below` is a relative step so it stays strictly under the cut at any magnitude. */
  const bounds = (ind: Indicator) => {
    const amber = ind.thresholds.amberLevel!;
    const red = ind.thresholds.redLevel!;
    // Non-vacuity: an absent/degenerate pair would make every assertion below trivially true.
    expect(amber, ind.id).toBeGreaterThan(0);
    expect(red, ind.id).toBeGreaterThan(amber);
    return { amber, red, below: amber * (1 - 1e-4) };
  };

  for (const id of CASES) {
    test(`${id}: EXACTLY at its registry cut fires - intentional + fail-safe`, () => {
      const ind = indFor(id);
      const { amber, red } = bounds(ind);
      // AT the cut: the synthesized EVT leg fires where convention's strict `>` does not.
      expect(score(ind, amber)).toBe("AMBER");
      expect(score(ind, red)).toBe("RED");
      // Fail-safe by DIRECTION: the flip only ever escalates. Without the seam these are GREEN
      // (amber) / AMBER (red) — i.e. the change fires EARLIER, never later, at every boundary.
      expect(scoreIndicator(ind, flat(amber)).state).toBe("GREEN");
      expect(scoreIndicator(ind, flat(red)).state).toBe("AMBER");
    });

    test(`${id}: a NON-boundary day is byte-identical to convention (a diff here is a BUG)`, () => {
      // The 6.2b deliverable: EVERY band change is attributable to an exact-boundary touch.
      // Just below the cut, and comfortably above it, the seam must change nothing at all.
      const ind = indFor(id);
      const { amber, red, below } = bounds(ind);
      for (const v of [below, amber * 0.5, (amber + red) / 2, red * 1.5]) {
        expect(score(ind, v), `${id} @ ${v}`).toBe(scoreIndicator(ind, flat(v)).state);
      }
    });
  }

  test("Stage 6.3 - with NO history the VELOCITY legs fall back to the id's OWN velocity prior", () => {
    // Through 6.2b `legs:{level,velocity}` merged both axes off the SAME metric names, so the
    // LEVEL prior landed on velEvt* and the velocity axis was inert by DOMINATION. Stage 6.3
    // dissolves that: `withSynthesizedPriors` emits SEPARATE `evt_vel_*` rows and `resolveCuts`
    // prefers them. On the degraded (no-history) path those rows carry the registry VELOCITY
    // prior — so the velocity leg now sits at its own convention value, at the same fail-safe
    // inclusive-vs-strict knife-edge as the level leg, instead of being unreachable.
    for (const id of VEL_CASES) {
      const ind = indFor(id);
      const cuts = resolveCuts(ind.id, synthesizedCalib(ind, []), "HIGH");
      expect(cuts.velEvtAmber, ind.id).toBe(ind.thresholds.amberVelocity);
      expect(cuts.velEvtRed, ind.id).toBe(ind.thresholds.redVelocity);
      // The level axis is untouched by the velocity rows (no cross-contamination).
      expect(cuts.evtAmber, ind.id).toBe(ind.thresholds.amberLevel);
    }
    // Drive it: a ramp whose delta20 clears the convention velocity leg still scores the same
    // as convention everywhere except EXACTLY at the cut — the accepted knife-edge, nothing more.
    const f3 = byId("F3");
    const ramping = Array.from({ length: N }, (_, i) => ({ date: `d${i}`, value: 6 + i * 0.02 }));
    expect(scoreWithCuts(f3, ramping, []).state).toBe(scoreIndicator(f3, ramping).state);
  });
});

describe("Stage 6.3 - computed expanding-percentile cuts for the synthPriors ids", () => {
  // A history long enough to clear PCT_MIN_OBS, with a level distribution deliberately
  // DIFFERENT from its |Δ20| distribution — the regime where a velocity cut copied off the
  // level series (the 6.2b domination bug) would be visibly wrong.
  const n = PCT_MIN_OBS + 200;
  const wave = Array.from({ length: n }, (_, i) => 100 + 10 * Math.sin(i / 7));

  test("level cuts are the point-in-time 85th/95th of the LEVEL series", () => {
    const cuts = computeSynthCuts(wave, { amberLevel: 999, redLevel: 999 });
    expect(cuts.amberLevel).toBe(expandingPercentile(wave, SYNTH_AMBER_PCTILE).at(-1));
    expect(cuts.redLevel).toBe(expandingPercentile(wave, SYNTH_RED_PCTILE).at(-1));
    expect(cuts.redLevel!).toBeGreaterThan(cuts.amberLevel!);
    // Not the prior: the whole point of 6.3 is that the hand-typed number is GONE.
    expect(cuts.amberLevel).not.toBe(999);
  });

  test("velocity cuts are the 85th/95th of |Δ20| - NOT the level series (kills domination)", () => {
    const cuts = computeSynthCuts(wave, { amberVelocity: 999, redVelocity: 999 });
    const d20 = wave.slice(SYNTH_VEL_WINDOW).map((v, i) => Math.abs(v - wave[i]!));
    expect(cuts.amberVelocity).toBe(expandingPercentile(d20, SYNTH_AMBER_PCTILE).at(-1));
    expect(cuts.redVelocity).toBe(expandingPercentile(d20, SYNTH_RED_PCTILE).at(-1));
    // The 6.2b failure mode, pinned as an anti-assertion: the level cut (~110) can never be
    // the velocity cut (a bounded |Δ20| on a ±10 wave), so the velocity leg is REACHABLE.
    expect(cuts.amberVelocity!).toBeLessThan(cuts.amberLevel ?? Infinity);
    expect(cuts.amberVelocity!).toBeLessThan(20);
  });

  test("below PCT_MIN_OBS every leg falls back to the prior - never NaN, never widened", () => {
    const thin = wave.slice(0, PCT_MIN_OBS); // exactly at the floor ⇒ no PRE-t window yet
    // ⚠ **NO CARRIER ID since 2026-08-08**. This
    // assertion is about `computeSynthCuts`, which is id-AGNOSTIC — it takes a `Thresholds` and a
    // series and never looks an indicator up. It rode a live registry prior (F9 → F11 2026-08-07)
    // only to avoid a second source of that id's cuts; but "EVERY leg falls back" needs a prior that
    // HAS all four legs, and after F11's level axis was retired NO `synthPriors` id has all four
    // (F3 is level+amber-velocity only). Rather than weaken the regime to whatever the last carrier
    // happens to have, the 4-leg prior is now a SYNTHETIC literal — these numbers pin nothing about
    // any indicator, they only have to be four distinct finite legs, so they can never rot against a
    // retune. Same move the F9 arc made when `drift-guard`'s population stopped admitting F9.
    const prior = { amberLevel: 7, redLevel: 9, amberVelocity: 0.3, redVelocity: 0.7 };
    expect(computeSynthCuts(thin, prior)).toEqual(prior);
    expect(computeSynthCuts([], prior)).toEqual(prior);
    // The fail-safe direction: a thin history leaves the band exactly where it was, so it can
    // only ever fire as early as before — a NaN/absent cut would silently WIDEN it.
    for (const v of Object.values(computeSynthCuts(thin, prior))) expect(Number.isFinite(v)).toBe(true);
  });

  test("the emitted rows carry the COMPUTED values through resolveCuts (every synth id)", () => {
    const histories = new Map(SYNTH_PRIOR_IDS.map((id) => [id, wave]));
    for (const id of SYNTH_PRIOR_IDS) {
      const ind = byId(id);
      const cuts = resolveCuts(id, synthesizedCalib(ind, [], histories), "HIGH");
      // Thread the per-id velocity window (F3: 4-week) so `want` is computed over the SAME |Δ|
      // the seam used — otherwise F3's Δ4 cut is compared against a Δ20 `want` and drifts.
      const want = computeSynthCuts(wave, priorThresholds(ind), ind.velocityWindow ?? SYNTH_VEL_WINDOW);
      expect(cuts.evtAmber, id).toBe(want.amberLevel);
      expect(cuts.evtRed, id).toBe(want.redLevel);
      expect(cuts.velEvtAmber, id).toBe(want.amberVelocity);
      expect(cuts.velEvtRed, id).toBe(want.redVelocity);
      // Option B uses no z leg at all for these ids (6.2b invariant, still true).
      expect(usesOwnSeriesZ(id), id).toBe(false);
    }
  });

  test("m ≠ 1 scales the computed cut EXACTLY ONCE (the 6.2b double-scale is dissolved)", () => {
    // 6.2b read the synth value off `indicator.thresholds`, which `withMultipliedThresholds`
    // had ALREADY scaled by m — and `resolveCuts` then applied m again via `scaleCuts`. 6.3
    // feeds a RAW-series statistic in, so `scaleCuts`' application is the only one.
    // ⚠ Carrier moved F9 → F11 on 2026-08-07, then **F11 → F3 on 2026-08-08** (Stage 1 of
    // each scorer redesign): the
    // double-scale this pins is primarily a LEVEL-axis defect (`evtAmber` off `amberLevel`), and
    // neither F9 nor F11 has a level axis to scale twice any more. **F3 is now the only `synthPriors`
    // id with a level axis at all**, so it is the carrier by elimination, not by preference. Both
    // axes are still exercised — F3 is AMBER-ONLY on velocity (`domain-cuts.ts` §F3), which is why
    // only the amber velocity leg is asserted below; a `velEvtRed` assertion would be vacuous here.
    // Its `velocityWindow: 4` must be threaded into `want`, or the Δ4 cut the seam resolves is
    // compared against a Δ20 expectation and drifts.
    const cfg = { default: 1, multipliers: { F3: { multiplier: 0.5 } } };
    const scaled = withMultipliedThresholds(byId("F3"), cfg);
    // The fallback path is dissolved too: `priorThresholds` reads the PRE-multiplier bands.
    expect(scaled.thresholds.amberLevel).not.toBe(byId("F3").thresholds.amberLevel);
    expect(priorThresholds(scaled)).toEqual(byId("F3").thresholds);
    const histories = new Map([["F3", wave]]);
    const want = computeSynthCuts(wave, priorThresholds(scaled), byId("F3").velocityWindow ?? SYNTH_VEL_WINDOW);
    const cuts = resolveCuts("F3", synthesizedCalib(scaled, [], histories), "HIGH", cfg);
    expect(cuts.evtAmber).toBe(earlierCut(want.amberLevel!, true, 0.5));
    expect(cuts.velEvtAmber).toBe(earlierCut(want.amberVelocity!, true, 0.5));
    // The falsifier: a double application would land on earlierCut(earlierCut(x)).
    expect(cuts.evtAmber).not.toBe(earlierCut(earlierCut(want.amberLevel!, true, 0.5), true, 0.5));
  });

  test("the degrade flag is honest: a deep history is computed, a thin one falls back to priors", () => {
    // `withSynthesizedPriors` emits `evt_*` rows on BOTH paths, so the resolved cuts look
    // identical in SHAPE and row presence cannot tell a computed percentile from the
    // hand-typed `PRIORS — uncalibrated` band — the distinction only exists in this flag.
    // (Its `/api` consumer, `indicatorProvenance`, went with the wire field on 2026-07-30;
    // `synthCutsDegraded` now has no live caller — this is its remaining pin.)
    const thin = wave.slice(0, PCT_MIN_OBS); // every leg falls back to the prior
    for (const id of SYNTH_PRIOR_IDS) {
      const ind = byId(id);
      const deep = new Map([[id, wave]]);
      const thinMap = new Map([[id, thin]]);
      expect(synthCutsDegraded(ind, deep), id).toBe(false);
      expect(synthCutsDegraded(ind, thinMap), id).toBe(true);
      expect(synthCutsDegraded(ind, undefined), id).toBe(true); // no history loaded at all
      // Non-vacuity: the two histories really do resolve to DIFFERENT cuts, so the flag is
      // separating two reachable states rather than labelling one.
      const cutsOf = (h: Map<string, readonly number[]>) =>
        resolveCuts(id, synthesizedCalib(ind, [], h), "HIGH");
      expect(cutsOf(deep), id).not.toEqual(cutsOf(thinMap));
    }
  });

  test("the velocity axis degrades DEEPER than the level axis (per-leg, not whole-history)", () => {
    // The emitter's old whole-history flag missed this band entirely: at 253–272 observations
    // the level percentile is real while |Δ20| is still 20 short of the floor, so both
    // velocity cuts are priors — an id the golden used to record as `degraded: false`.
    const between = wave.slice(0, PCT_MIN_OBS + 10); // > minObs on level, < minObs on velocity
    // ⚠ **NO CARRIER ID since 2026-08-08**, for the
    // reason given on the `below PCT_MIN_OBS` test above: the assertion is a COMPARISON of the two
    // axes' degrade depths, so it needs a prior with all four legs, and no `synthPriors` id has one
    // any more (F9's and F11's level axes are retired; F3 is amber-only on velocity, so its
    // `degraded.redVelocity` would be vacuously undefined rather than `true`). `computeSynthCutsDetailed`
    // is id-agnostic, so a SYNTHETIC 4-leg literal preserves the regime exactly and cannot rot.
    const prior = { amberLevel: 7, redLevel: 9, amberVelocity: 0.3, redVelocity: 0.7 };
    const { cuts, degraded } = computeSynthCutsDetailed(between, prior);
    expect(degraded.amberLevel).toBe(false);
    expect(degraded.redLevel).toBe(false);
    expect(degraded.amberVelocity).toBe(true);
    expect(degraded.redVelocity).toBe(true);
    expect(degraded.any).toBe(true);
    // ...and the degraded legs really are the prior verbatim, not a NaN or a widened band.
    expect(cuts.amberVelocity).toBe(prior.amberVelocity);
    expect(cuts.redVelocity).toBe(prior.redVelocity);
    expect(cuts.amberLevel).not.toBe(prior.amberLevel);
  });

  test("a LEVEL-ONLY prior computes no velocity axis and flags no phantom degrade", () => {
    // Stage 1 of 6.4: a synth id whose registry prior defines LEVEL only.
    // `resolveCuts` gates the velocity legs on `CALIB_MAP[id].legs.velocity`, so a synthesized
    // `evt_vel_*` row for it is emitted and never read — but the old unconditional compute
    // folded its (necessarily degraded, since there is no prior to fall back to) flags into
    // `degraded.any`, reporting `convention` for an id whose LIVE level cuts are measured.
    const { cuts, degraded } = computeSynthCutsDetailed(wave, { amberLevel: 999, redLevel: 999 });
    expect(cuts.amberVelocity).toBeUndefined();
    expect(cuts.redVelocity).toBeUndefined();
    expect(degraded.amberVelocity).toBe(false);
    expect(degraded.redVelocity).toBe(false);
    // The level axis is live, measured, and NOT the prior ⇒ nothing degraded at all.
    expect(cuts.amberLevel).toBe(expandingPercentile(wave, SYNTH_AMBER_PCTILE).at(-1));
    expect(degraded.any).toBe(false);
    // Falsifier for the fix: on a thin history the LIVE axis still degrades honestly.
    expect(
      computeSynthCutsDetailed(wave.slice(0, PCT_MIN_OBS), { amberLevel: 999, redLevel: 999 })
        .degraded,
    ).toMatchObject({ amberLevel: true, redLevel: true, amberVelocity: false, any: true });
  });

  test("every synth id's prior-derived axes AGREE with the axes resolveCuts opens", () => {
    // The invariant, not the instance: `synth-cuts.ts` derives live axes from the registry
    // PRIOR while `resolveCuts` gates on `CALIB_MAP[id].legs`. A mismatch in the unsafe
    // direction (`legs.velocity` true against a level-only prior) emits no `evt_vel_*` rows
    // while the velocity legs stay open — they resolve to nothing and the band WIDENS.
    // Derived, so adding a level-only synth id extends the pin instead of
    // breaking a hardcoded literal.
    for (const id of SYNTH_PRIOR_IDS) {
      const ind = byId(id);
      expect(synthAxesFor(priorThresholds(ind)), id).toEqual(calibLegsFor(id));
    }
  });

  test("F10 resolves to its REGISTRY priors - the 2026-07-18 revert off the synth seam", () => {
    // Stage 6.3 shipped F10 on computed cuts (2.38/2.64 vs then-priors 3.5/4.5) off the same
    // server-truncated ICE BofA FRED feed that falsified the computed-cuts hypothesis; option C
    // reverted it. Three facts, each of which the old wiring violated:
    const f10 = byId("F10");
    expect(hasSynthPriors("F10")).toBe(false);
    // (1) the seam is the identity for it — a deep history cannot inject a computed row...
    const vintage: never[] = [];
    expect(synthesizedCalib(f10, vintage, new Map([["F10", wave]]))).toBe(vintage);
    // (2) ...so `resolveCuts` opens NO measured leg (F10 is absent from CALIB_MAP, and its
    // `credit/emcbpioas` prefix was synth-private — no harness ever publishes it)...
    expect(resolveCuts("F10", synthesizedCalib(f10, vintage, new Map([["F10", wave]])), "HIGH")).toEqual({});
    // (3) ...and scoring therefore falls through to the hand-typed registry bands. Pinned
    // by VALUE: a silent re-computation would move these, which is the whole defect.
    expect(f10.thresholds).toMatchObject({ amberLevel: 1.62, redLevel: 1.8, amberVelocity: 0.4, redVelocity: 0.8 });
    // ...the two edge probes DERIVE from that same pin, so a retune needs no fixture edit here.
    expect(scoreIndicator(f10, flat(f10.thresholds.amberLevel! + 0.1)).state).toBe("AMBER");
    expect(scoreIndicator(f10, flat(f10.thresholds.redLevel! + 0.1)).state).toBe("RED");
    // The falsifier for the revert itself: the hand cuts sit BELOW the computed 2.38/2.64 pair,
    // so a 2.0 level is RED off the registry and GREEN off the seam — re-wiring the seam flips it.
    expect(scoreIndicator(f10, flat(2.0)).state).toBe("RED");
  });

  test("W1 slice 2: F3 can LEAVE GREEN on its own history - the dead 0.5/1.0 cut is displaced", () => {
    // The shipped defect: `NFCIRISK` regime-shifted and its post-2010 maximum is 0.136, so the
    // hand-typed 0.5 amber is a level the series never reaches — F3 was a permanently silent
    // FIN-channel input, GREEN by construction rather than by measurement.
    const f3 = byId("F3");
    // A history in that regime (every observation far below the prior amber), standing in for
    // the real weekly series. 1,000 obs ⇒ past PCT_MIN_OBS on the level axis.
    const history = Array.from({ length: 1000 }, (_, i) => -0.6 + (0.8 * i) / 999);
    // Precondition, asserted not assumed — without an UNREACHABLE prior this proves nothing.
    expect(Math.max(...history)).toBeLessThan(f3.thresholds.amberLevel!);
    const measured = computeSynthCuts(history, priorThresholds(f3));
    expect(measured.redLevel!).toBeLessThan(f3.thresholds.amberLevel!);
    // Dual-leg now (R2): an AMBER-ONLY velocity axis IS computed, but the RED one never is —
    // the registry prior defines `amberVelocity` and leaves `redVelocity` unset.
    expect(measured.amberVelocity).toBeDefined();
    expect(measured.redVelocity).toBeUndefined();
    expect(calibLegsFor("F3")).toEqual({ level: true, velocity: true });
    const histories = new Map([["F3", history]]);
    // The real notify path (`run-dbfirst.ts` → `confirmers.scoreWithCuts`). Values derived from the
    // cut, never re-typed. Under the shipped code EVERY one of these was GREEN.
    expect(scoreWithCuts(f3, flat(measured.redLevel!), [], undefined, histories).state).toBe("RED");
    expect(
      scoreWithCuts(f3, flat((measured.amberLevel! + measured.redLevel!) / 2), [], undefined, histories).state,
    ).toBe("AMBER");
    // …and it still says GREEN in the calm part of its own distribution — the displacement
    // must not leave the indicator permanently lit either.
    expect(scoreWithCuts(f3, flat(history[0]!), [], undefined, histories).state).toBe("GREEN");
    // The DEGRADE path, pinned because for F3 it is not fail-safe: with no history the cut
    // reverts to the unreachable 0.5/1.0 and the indicator switches itself back off.
    expect(scoreWithCuts(f3, flat(measured.redLevel!), [], undefined, undefined).state).toBe("GREEN");
    expect(synthCutsDegraded(f3, undefined)).toBe(true);
  });

  test("R2: F3's velocity leg is a runtime p85 of the 4-WEEK Δ, fires AMBER, and NEVER Red", () => {
    const f3 = byId("F3");
    const prior = priorThresholds(f3);
    const win = f3.velocityWindow ?? SYNTH_VEL_WINDOW; // 4 (weekly ⇒ 4-week Δ)
    const measured = computeSynthCuts(wave, prior, win);

    // (a) The amber velocity cut IS the point-in-time p85 of the 4-OBSERVATION |Δ| — computed at
    // runtime, NOT the dead 0.5 registry fallback — and there is NO red velocity cut at all.
    const dWin = wave.slice(win).map((v, i) => Math.abs(v - wave[i]!));
    expect(measured.amberVelocity).toBe(expandingPercentile(dWin, SYNTH_AMBER_PCTILE).at(-1));
    expect(measured.amberVelocity).not.toBe(prior.amberVelocity); // ≠ the dead 0.5 fallback
    expect(measured.redVelocity).toBeUndefined();

    // (c) The LEVEL leg is byte-unchanged: still exactly the p85/p95 of the level series,
    // uninfluenced by the velocity axis this stage added.
    expect(measured.amberLevel).toBe(expandingPercentile(wave, SYNTH_AMBER_PCTILE).at(-1));
    expect(measured.redLevel).toBe(expandingPercentile(wave, SYNTH_RED_PCTILE).at(-1));

    // (b) The REAL notify path (`run-dbfirst.ts` → `scoreWithCuts`). Drive a series that is GREEN on
    // LEVEL (0 ≪ amberLevel ≈ 107) but whose last closes each carry a large POSITIVE 4-week Δ (a
    // deep dip exactly `win` obs back). Only the velocity leg can explain the AMBER — and under
    // window=20 the dip sits outside the lookback (Δ20 = 0), so this reddens if F3 loses `win`=4.
    const histories = new Map([["F3", wave]]);
    const dip = (depth: number): Observation[] => {
      const s: Observation[] = Array.from({ length: N }, (_, i) => ({ date: `d${i}`, value: 0 }));
      for (const k of [N - 5, N - 6, N - 7]) s[k]!.value = depth; // ⇒ Δ4 = -depth on the last 3
      return s;
    };
    expect(scoreWithCuts(f3, dip(-1000), [], undefined, histories).state).toBe("AMBER");
    // Extreme velocity STILL only AMBER — with no `redVelocity` cut the leg can never vote Red,
    // and the level is GREEN throughout so nothing else can escalate it either.
    expect(scoreWithCuts(f3, dip(-1e6), [], undefined, histories).state).toBe("AMBER");
    // A calm (flat) series leaves it GREEN — the velocity leg is not stuck on.
    expect(scoreWithCuts(f3, flat(0), [], undefined, histories).state).toBe("GREEN");
  });

  test("a non-synthPriors id is untouched by the seam (referential identity)", () => {
    const vintage = [{ channel: "rate", metric: "t10y3m_evt_level_amber", value: 0.2 }];
    expect(synthesizedCalib(byId("R1"), vintage, new Map([["R1", wave]]))).toBe(vintage);
    expect(hasSynthPriors("R1")).toBe(false);
  });

  test("loadSynthHistories degrades to an empty map when the store throws", async () => {
    const boom = { getSeriesBulk: () => Promise.reject(new Error("db down")) };
    expect((await loadSynthHistories(boom)).size).toBe(0);
  });

  // --- The committed golden (Option B's reviewable artifact) ----------------------------
  describe("golden: scripts/backtest/synth_cuts.json", () => {
    test("the axis CARRIERS are pinned by name - the conditional golden branches need an oracle", () => {
      // The golden test below branches on `synthAxesFor(priorThresholds(ind))`, i.e. on the same
      // registry the golden is REGENERATED from. That makes the branch self-consistent under a
      // silent loss: drop F3's or F11's level prior, regen, and the `axes.level` arm simply stops
      // being taken while both sides agree — green on an axis that quietly left the product. This
      // pin is the independent oracle: it names the carriers, so a departure reds HERE even though
      // the branch above stays green. It is intentionally a hardcoded membership list — adding or
      // retiring an axis is a deliberate act (F9's level pair, 2026-08-07 Stage 1) and owes an
      // edit here plus a plan cite, not a derivation that follows the registry wherever it goes.
      const carriers = (axis: "level" | "velocity") =>
        [...SYNTH_PRIOR_IDS].filter((id) => synthAxesFor(priorThresholds(byId(id)))[axis]).sort();
      // F3 is the ONLY level carrier on the synth seam — this pin is what stands between "one id"
      // and "no ids", and the level branch below going vacuous entirely.
      expect(carriers("level")).toEqual(["F3"]);
      // ⚠ **The seam is a SINGLETON since 2026-08-09.** F9 left it whole on 2026-08-08
      // and F11 on 2026-08-09,
      // both replacing a percentile with
      // a fixed σ pair on the registry — so neither is in `SYNTH_PRIOR_IDS` at all and neither can
      // appear on either side. F3 now carries BOTH axes alone, which means the two `carriers` lists
      // are identical and the velocity-ONLY side of the level-axis fold below is NO LONGER EXERCISED by
      // any live id. ⛔ Do not read the fold's velocity-only side as covered; it is dark until an
      // id joins the seam with a velocity axis and no level axis.
      expect(carriers("velocity")).toEqual(["F3"]);
    });

    test("covers exactly the synthPriors ids, with red beyond amber on both axes", () => {
      expect(Object.keys(SYNTH_GOLDEN.cuts).sort()).toEqual([...SYNTH_PRIOR_IDS].sort());
      // Structurally typed because the golden is now HETEROGENEOUS: a level-only id (F3)
      // omits the velocity fields entirely, so the imported JSON's per-id types differ and
      // the shared loop must read them as optional rather than assume the dual-axis shape.
      const entries = Object.entries(SYNTH_GOLDEN.cuts) as Array<
        [
          string,
          {
            series: string;
            nObs: number;
            nObsVelocity?: number;
            degraded: boolean;
            degradedLegs: Record<string, boolean>;
            amberLevel: number;
            redLevel: number;
            amberVelocity?: number;
            redVelocity?: number;
          },
        ]
      >;
      const finiteOrAbsent = (v: number | undefined): string => (v === undefined ? "absent" : Number.isFinite(v) ? "finite" : "non-finite");
      const rows = entries.map(([id, g]) => {
        const ind = byId(id);
        // The axes the id ACTUALLY carries, derived from its registry prior — the same
        // derivation the emitter and `resolveCuts` use, so a golden that records a velocity
        // cut for a level-only id (or drops one for a dual-axis id) fails here.
        return { id, g, ind, axes: synthAxesFor(priorThresholds(ind)) };
      });
      for (const { id, g, ind, axes } of rows) {
        // The LEVEL axis is conditional exactly as the velocity one is below — F11 retired its level
        // pair (2026-08-08 Stage 1) and is velocity-only, so an unconditional finite-level assertion
        // here indicts a shape the registry no longer produces. The same branch read as green for F9
        // until the 2026-08-07 regen only because the committed golden still carried F9's PRE-Stage-1
        // level values; a stale artifact was standing in for the axis. (F9 itself left the golden
        // entirely 2026-08-08.)
        // …and a velocity-only id records NO level axis: an emitted cut there would advertise a
        // number nothing is ever compared against (the mirror of the level-only case below).
        expect([g.amberLevel, g.redLevel].map(finiteOrAbsent), id).toEqual(axes.level ? ["finite", "finite"] : ["absent", "absent"]);
        expect(g.nObs, id).toBeGreaterThan(PCT_MIN_OBS);
        expect(g.series, id).toBe(ind.series);
        // Velocity shape keyed off the registry PRIOR (the same source `computeSynthCutsDetailed` gates
        // on): an id with a prior `redVelocity` emits amber+red velocity cuts; one without (F3, the seam's
        // only member) emits an amber velocity cut and NO red. The per-id `velocityWindow` (4 for F3's
        // weekly 4-week Δ, the global 20 otherwise) sets how much shorter the velocity window is than the level one.
        // An amber-only leg never computes or emits the red velocity cut, so it can never raise
        // the velocity leg to Red; a level-only id records NO velocity axis at all: an emitted cut
        // or window there would advertise a number nothing is ever compared against.
        const wantRedVel = priorThresholds(ind).redVelocity !== undefined;
        const velWindow = ind.velocityWindow ?? SYNTH_VEL_WINDOW;
        expect(finiteOrAbsent(g.amberVelocity), id).toBe(axes.velocity ? "finite" : "absent");
        expect(finiteOrAbsent(g.redVelocity), id).toBe(axes.velocity && wantRedVel ? "finite" : "absent");
        // Per-LEG depth, recorded per axis: the |Δ| window is `velocityWindow` observations
        // shorter than the level one, so a whole-history flag would report a clean `false` for
        // an id whose velocity cuts are silently the prior.
        expect(g.nObsVelocity, id).toBe(axes.velocity ? g.nObs - velWindow : undefined);
        expect(g.degraded, id).toBe(false);
        expect(Object.values(g.degradedLegs), id).toEqual([false, false, false, false]);
      }
      const levelRows = rows.filter((r) => r.axes.level);
      expect(levelRows.length).toBeGreaterThan(0);
      for (const { id, g } of levelRows) expect(g.redLevel, id).toBeGreaterThanOrEqual(g.amberLevel);
      // Both counts must clear the floor.
      const velocityRows = rows.filter((r) => r.axes.velocity);
      expect(velocityRows.length).toBeGreaterThan(0);
      for (const { id, g } of velocityRows) {
        expect(g.nObsVelocity!, id).toBeGreaterThan(PCT_MIN_OBS);
      }
    });

    test("the golden names the store it was read from (nObs is store-relative)", () => {
      // F3's ~783 obs vs F11's ~3,700 is a property of the DB this was emitted
      // against, not of the feed — unreadable without the label. (F10's ~767 was the
      // starkest case until its 2026-07-18 revert; there the shortfall was the FEED, a
      // truncated ICE BofA window, which is exactly why the label alone is not enough and
      // the constraint is recorded in `registry.ts`.) A label only — never a credential or
      // the hosted project's hostname (`storeLabel` in scripts/emit-synth-cuts.ts).
      expect(SYNTH_GOLDEN.source).toMatch(/^(prod|dev \([^)]*\)|unknown)$/);
    });

    test("the golden's method block still matches the live constants (a knob bump fails here)", () => {
      // The golden is a VALUE record; this pins the METHOD that produced it, so retuning a
      // percentile or the velocity window can never leave a stale artifact looking authoritative.
      expect(SYNTH_GOLDEN.method).toMatchObject({
        amberPercentile: SYNTH_AMBER_PCTILE,
        redPercentile: SYNTH_RED_PCTILE,
        velocityWindow: SYNTH_VEL_WINDOW,
        minObs: PCT_MIN_OBS,
      });
    });
  });
});

describe("R8 mean-space expanding-percentile pair + velocity leg (R8_MEAN_POST_INVERSION)", () => {
  const R8 = byId("R8");
  const cfg = R8.postInversionCooldown!;
  const lc = cfg.levelCuts!;
  const DAY = 86_400_000;
  const anchorMs = Date.parse(cfg.cutAnchorDate);
  const dateAt = (i: number) => new Date(anchorMs + i * DAY).toISOString().slice(0, 10);
  // Expectation oracle, derived from the cfg knobs alone — no knob value restated in this file.
  const pctileOf = (pool: number[], s: { pctile: number; clamp: [number, number] }) => {
    const v = [...pool].sort((a, b) => a - b)[Math.floor(s.pctile * (pool.length - 1))]!;
    return Math.min(s.clamp[1], Math.max(s.clamp[0], v));
  };
  // Post-anchor fixture: a qualifying mean-inversion, then an alternating two-value distribution —
  // the high value sits INSIDE amber's clamp (≥ floorLevel, but never releaseN consecutive), the low
  // value INSIDE red's clamp — so past warm-up BOTH cuts are unclamped percentiles, not bound hits.
  const lowVal = (lc.red.clamp[0] + lc.red.clamp[1]) / 2;
  const highVal = (lc.amber.clamp[0] + lc.amber.clamp[1]) / 2;
  const means = [
    ...Array<number>(cfg.qualifyN).fill(-1),
    ...Array.from({ length: cfg.cutWarmupObs }, (_, i) => (i % 2 === 0 ? lowVal : highVal)),
  ];
  const meanDates = means.map((_, i) => dateAt(i));

  test("warm-up: amber holds floorLevel, red is ABSENT; past warm-up both are the clamped percentiles", () => {
    const { amber, red } = meanLevelCutSeries(means, meanDates, cfg);
    // Armed at the qualifying run's end, pool still under warm-up.
    expect(amber[cfg.qualifyN - 1]).toBe(cfg.floorLevel);
    expect(red[cfg.qualifyN - 1]).toBeNull();
    // Terminal pool = the whole fixture; both oracles discriminate percentile from hold and clamp.
    expect(pctileOf(means, lc.amber)).not.toBe(cfg.floorLevel);
    expect(amber.at(-1)).toBe(pctileOf(means, lc.amber));
    expect(red.at(-1)).toBe(pctileOf(means, lc.red));
    // Vacuity: neither terminal cut sits ON a clamp bound — the percentile itself is what's pinned.
    expect(lc.amber.clamp).not.toContain(amber.at(-1));
    expect(lc.red.clamp).not.toContain(red.at(-1));
  });

  // Velocity leg through R8's own scorer, window 1 so the mean IS the close: all-positive values
  // never arm the rung (cuts null ⇒ level leg GREEN), so state below is the velocity leg alone.
  const av = R8.thresholds.amberVelocity!;
  const rv = R8.thresholds.redVelocity!;
  const vw = R8.velocityWindow!;
  // base = 2·av makes every boundary subtraction below EXACT (Sterbenz: x−y is exact for
  // y ∈ [x/2, x]), so `base − (base − cut)` reproduces the cut double bit-for-bit and the
  // strict-> comparisons are tested at TRUE equality, not a float neighbour.
  const base = av + av;
  const velState = (finalVal: number) => {
    const vals = [...Array<number>(vw + 2).fill(base), finalVal];
    const obs = vals.map((v, i) => ({ date: dateAt(i), value: v }));
    return smoothedLevelReadingSeries(R8, obs, 1).at(-1)!.state;
  };

  test("a FALL fires on the strict-> boundary; a RISE of the same magnitude never fires (LOW flip)", () => {
    // Premises: Sterbenz range for the red boundary, and every value stays positive (never arms).
    expect(rv).toBeGreaterThan(av);
    expect(rv).toBeLessThan(base);
    expect(velState(base - av)).toBe("GREEN"); // Δ == amber cut exactly: strict >, no fire
    expect(velState(base - av - 0.001)).toBe("AMBER");
    expect(velState(base - rv)).toBe("AMBER"); // past amber, ON red's boundary exactly
    expect(velState(base - rv - 0.001)).toBe("RED");
    expect(velState(base + rv + 0.001)).toBe("GREEN"); // the rise — LOW-flip discriminator
  });
});

// Cron pool INCLUSIVE of today (ruled [USER] 2026-09-02): the stored history is loaded before the
// run's own row persists, so the cron appends its newest observation — matching the restate's
// per-day pool and the read path's post-persist window. Exclusive-by-one was a ~1e-4 split the
// 1e-9 parity probe flagged on every cron-written row.
describe("synthHistoriesInclusive (cron pool appends the run's own newest observation)", () => {
  const stored = [
    { date: "2026-08-14", value: -0.5 },
    { date: "2026-08-21", value: -0.4 },
  ];
  const source = { getSeriesBulk: async () => new Map([["F3", stored]]) };

  test("loadSynthHistoriesDated carries the newest stored date per id; loadSynthHistories is its values-only view", async () => {
    const load = await loadSynthHistoriesDated(source);
    expect(load.histories.get("F3")).toEqual([-0.5, -0.4]);
    expect(load.lastDate.get("F3")).toBe("2026-08-21");
    expect(await loadSynthHistories(source)).toEqual(load.histories);
  });

  test("appends the newest observation when it post-dates the newest stored row", async () => {
    const load = await loadSynthHistoriesDated(source);
    const obs = [...stored, { date: "2026-08-28", value: -0.3 }];
    const out = synthHistoriesInclusive(load, "F3", obs);
    expect(out.get("F3")).toEqual([-0.5, -0.4, -0.3]);
    expect(load.histories.get("F3")).toEqual([-0.5, -0.4]); // never mutates the load
  });

  test("a same-day re-run (today already stored) appends nothing", async () => {
    const load = await loadSynthHistoriesDated(source);
    expect(synthHistoriesInclusive(load, "F3", stored)).toBe(load.histories);
  });

  test("a non-synth id, an empty observation list, or an id with no stored history is left untouched", async () => {
    const load = await loadSynthHistoriesDated(source);
    const obs = [{ date: "2026-08-28", value: 1 }];
    expect(synthHistoriesInclusive(load, "F1", obs)).toBe(load.histories);
    expect(synthHistoriesInclusive(load, "F3", [])).toBe(load.histories);
    const empty = await loadSynthHistoriesDated({ getSeriesBulk: async () => new Map() });
    expect(synthHistoriesInclusive(empty, "F3", obs)).toBe(empty.histories);
  });

  // A4: stored D written at `offsetMin` from D's intraday cutoff (negative ⇒ provisional).
  const withD = (offsetMin: number) => {
    const runAt = new Date(Date.parse("2026-08-28T00:00:00Z") + (INTRADAY_CUTOFF_UTC_MIN + offsetMin) * 60_000);
    const rows = [...stored, { date: "2026-08-28", value: -0.3, runAt: runAt.toISOString() }];
    return { rows, src: { getSeriesBulk: async () => new Map([["F3", rows]]) } };
  };

  test("a provisional stored D is replaced by the EOD run's D value (pool length unchanged)", async () => {
    const { src } = withD(-60);
    const load = await loadSynthHistoriesDated(src);
    const out = synthHistoriesInclusive(load, "F3", [...stored, { date: "2026-08-28", value: -0.1 }]);
    expect(out.get("F3")).toEqual([-0.5, -0.4, -0.1]);
    expect(load.histories.get("F3")).toEqual([-0.5, -0.4, -0.3]); // never mutates the load
  });

  test("a provisional stored D with a run dated D-1 leaves only the final stored rows", async () => {
    const load = await loadSynthHistoriesDated(withD(-60).src);
    expect(synthHistoriesInclusive(load, "F3", stored).get("F3")).toEqual([-0.5, -0.4]);
  });

  // N1: a provisional row the run does NOT re-print stays in the pool, as the read path keeps it.
  test("a provisional stored D-1 tail with a run dated D keeps D-1 and appends D", async () => {
    const load = await loadSynthHistoriesDated(withD(-60).src);
    const out = synthHistoriesInclusive(load, "F3", [...stored, { date: "2026-08-28", value: -0.1 }, { date: "2026-09-04", value: -0.2 }]);
    expect(out.get("F3")).toEqual([-0.5, -0.4, -0.3, -0.2]);
  });

  test("a missed EOD: provisional D-1 at index -2 stays, only the re-printed provisional D tail is replaced", async () => {
    const { rows } = withD(-60);
    const dRunAt = new Date(Date.parse("2026-09-04T00:00:00Z") + (INTRADAY_CUTOFF_UTC_MIN - 60) * 60_000).toISOString();
    const both = [...rows, { date: "2026-09-04", value: -0.25, runAt: dRunAt }];
    const load = await loadSynthHistoriesDated({ getSeriesBulk: async () => new Map([["F3", both]]) });
    const out = synthHistoriesInclusive(load, "F3", [...stored, { date: "2026-09-04", value: -0.2 }]);
    expect(out.get("F3")).toEqual([-0.5, -0.4, -0.3, -0.2]);
  });

  test("a final stored D (run_at after its cutoff) is kept: the same-day re-run appends nothing", async () => {
    const { rows, src } = withD(60);
    const load = await loadSynthHistoriesDated(src);
    const out = synthHistoriesInclusive(load, "F3", [...stored, { date: "2026-08-28", value: -0.1 }]);
    expect(out).toBe(load.histories);
    expect(out.get("F3")).toEqual(rows.map((r) => r.value));
  });

  test("the appended pool is capped at SYNTH_HISTORY_LIMIT, dropping the oldest", () => {
    const hist = Array.from({ length: SYNTH_HISTORY_LIMIT }, (_, i) => i);
    const load = { histories: new Map([["F3", hist]]), lastDate: new Map([["F3", "2026-08-21"]]) };
    const out = synthHistoriesInclusive(load, "F3", [{ date: "2026-08-28", value: -1 }]);
    expect(out.get("F3")?.length).toBe(SYNTH_HISTORY_LIMIT);
    expect(out.get("F3")?.[0]).toBe(1);
    expect(out.get("F3")?.at(-1)).toBe(-1);
  });
});
