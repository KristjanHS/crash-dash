/**
 * The threshold-drift falsification guard (W1 slice 3, 2026-07-20).
 *
 * Fails when a level-cut indicator's scored state is constant across a trailing
 * `DRIFT_WINDOW_YEARS` of its own committed history — the defect class that left F9 pinned
 * RED since 2018 and F3 pinned GREEN since 2009 with no test, no error and no alert.
 *
 * ⚠ **F9 IS NO LONGER IN THIS GUARD'S POPULATION** (2026-08-07): its level axis was retired
 * and `levelCutIds()` admits registry
 * level-cut ids only. The equivalent property for F9 is now asserted on its VELOCITY axis in
 * `src/registry.test.ts`. F9 still appears below as an out-of-population CARRIER for the
 * function-layer PINNED demo, which is axis-agnostic.
 *
 * Runs in plain `npm run check`: committed CSV fixtures only, no network, no `DB_TESTS=1`.
 *
 * CAN-FAIL DEMONSTRATION (re-runnable — this guard is worthless if it cannot go red):
 *   (a) revert W1 slice 2 — drop F3 from `CALIB_MAP` (src/domain-cuts.ts) ⇒ F3 resolves the dead
 *       0.5/1.0 registry prior, is GREEN across all 15 years, its allowlist liveness
 *       precondition fails, and this suite goes red naming F3.
 *   (b) HISTORICAL, no longer runnable: reverting W1 slice 1 — dropping the four `operative_*`
 *       rows from `withSynthesizedPriors` (src/domain-cuts.ts) — once let F9's registry 110 survive as
 *       an OR-leg, making F9 RED for all 752 observations in the window and reddening this suite.
 *       F9 left the population 2026-08-07 (see the header), so this arm is history; (a) and (c)
 *       remain live and either alone demonstrates the guard can go red.
 *   (c) the SYNTH allowlist precondition (review finding C1) — append decaying `NFCIRISK`
 *       observations to `scripts/backtest/data/nfcirisk.csv` until the ratchet has consumed
 *       the 15y fitting window ⇒ the percentile follows the series down, so `regimeStates`
 *       still reports RED/AMBER/GREEN (that clause is tautological for a synth id and cannot
 *       revoke), but every crossing now sits in the OLDER half of the window and the
 *       recent-half assertion reds naming F3. Executed 2026-07-20 at a 16y decay to -2.0:
 *       last crossing 2029-09-21 against midpoint 2034-06-20. At the 5y decay it does NOT
 *       fire, correctly — two thirds of the window is still the old regime and F3 genuinely
 *       last signalled in 2025.
 * All three were executed 2026-07-20 and each produced the expected single failure.
 */
import { describe, expect, it } from "vitest";
import {
  DRIFT_CALM_ALLOWLIST,
  DRIFT_FIXTURES,
  DRIFT_WINDOW_YEARS,
  assessAll,
  assessDrift,
  driftReport,
  levelCutIds,
} from "./drift-guard.js";
import { ALL_INDICATORS } from "../../src/registry.js";
import { hasSynthPriors } from "../../src/domain-cuts.js";
import { readVintageText } from "../../src/hyoas-vintage.js";

const assessments = assessAll();
const byId = new Map(assessments.map((a) => [a.id, a]));

describe(`threshold-drift guard (${DRIFT_WINDOW_YEARS}y window)`, () => {
  it("covers every level-cut indicator in the registry (F1 included since its priors returned)", () => {
    // Anti-escape: a new absolute-cut indicator must be given a fixture or an explicit
    // unobservable reason. Both directions, so a stale DRIFT_FIXTURES key also fails.
    // F1 was carved out while Stage 1.3 (decision 4) left it prior-less; the hand-set 3.0/3.2
    // level pair returned 2026-07-23, so it is a registry level-cut id again and needs no
    // special case — its archived-vintage fixture keeps BOTH its prior and its measured
    // credit/hyoas cut drift-monitored. Set equality in both directions, as before.
    expect(levelCutIds()).toContain("F1");
    expect([...levelCutIds()].sort()).toEqual(Object.keys(DRIFT_FIXTURES).sort());
  });

  it("is not vacuous — every string-fixture id resolves a scored window", () => {
    // Without this a broken fixture path (or a readFixture regression — it silently drops
    // malformed rows) would turn the sweep UNOBSERVABLE and the guard would pass forever
    // while checking nothing. Stated as SET EQUALITY, not a count floor: a floor leaves one
    // slot of slack for every id above it, in which any single id
    // could flip to UNOBSERVABLE unnoticed. Equality is self-maintaining — adding a fixture
    // raises the bar automatically, and every id that names a CSV must score.
    const withFixture = Object.entries(DRIFT_FIXTURES)
      .filter(([, f]) => typeof f === "string")
      .map(([id]) => id)
      .sort();
    const scored = assessments.filter((a) => a.status !== "UNOBSERVABLE");
    expect(scored.map((a) => a.id).sort()).toEqual(withFixture);
    for (const a of scored) expect(a.nObs).toBeGreaterThan(30);
    // …and it must be able to observe more than one outcome, or the guard is a rubber stamp.
    expect(assessments.some((a) => a.status === "MOVES")).toBe(true);
    // The PINNED arm used to be demonstrated by an id that HAPPENED to be stuck (F3/EBP sat
    // there). Since the 2026-07-29 `[USER]` EBP retune every observable id MOVES — which is the
    // outcome this guard exists to produce, so a live-data demonstration of PINNED is no longer
    // available and asserting one would make a green suite depend on an indicator staying
    // broken. The arm is demonstrated at the FUNCTION's own layer instead: a genuinely constant
    // series must come back PINNED.
    // F9 is the CARRIER only — it is no longer in `DRIFT_FIXTURES`, and this demo calls
    // `assessDrift` directly rather than going through the sweep, so population membership is
    // irrelevant to it. Any indicator whose cuts a constant series cannot reach would do.
    const flat = ALL_INDICATORS.find((i) => i.id === "F9")!;
    // Spans MIN_OBSERVABLE_YEARS comfortably (one point every 3 days over ~8 years), else the
    // assessment is UNOBSERVABLE and the demo proves nothing.
    const start = Date.UTC(2016, 0, 1);
    const constant = Array.from({ length: 1000 }, (_, k) => ({
      date: new Date(start + k * 3 * 86_400_000).toISOString().slice(0, 10),
      // Constant ⇒ `delta20` ≡ 0 on every observation, below F9's velocity Amber cut (its axis
      // since the level retirement) ⇒ GREEN throughout ⇒ no state change.
      value: 1,
    }));
    expect(assessDrift(flat, constant).status).toBe("PINNED");
  });

  it("no absolute-cut indicator has been pinned for the whole window", () => {
    const pinned = assessments.filter(
      (a) => a.status === "PINNED" && DRIFT_CALM_ALLOWLIST[a.id] === undefined,
    );
    expect(pinned.map(driftReport).join("\n\n")).toBe("");
  });

  it("every allowlisted id is still merely CALM, not dead — the exemption self-revokes", () => {
    // An exemption is only honest while the cut remains REACHABLE by the series. Over the
    // wider per-id seed-depth regime window an allowlisted id must still take more than one
    // state; if it does not, its cut is dead across the modern regime and no note covers it.
    //
    // For a `synthPriors` id that clause alone is TAUTOLOGICAL — the cut IS the p85/p95 of
    // this very window, so ~15% of it exceeds amber by construction and the clause can never
    // be false (review finding C1). Such an id owes the second precondition below, which the
    // percentile does NOT fix.
    for (const [id, why] of Object.entries(DRIFT_CALM_ALLOWLIST)) {
      const a = byId.get(id);
      expect(a, `allowlist names ${id}, which the guard does not assess`).toBeDefined();
      expect(
        a!.regimeStates.length,
        `EXEMPTION REVOKED — ${id} ("${why}") is ${a!.regimeStates[0] ?? "constant"} across the ` +
          `whole seed-depth regime window, not just the ${DRIFT_WINDOW_YEARS}y guard ` +
          `window. Its cut ${JSON.stringify(a!.cuts)} is unreachable, i.e. real drift.\n` +
          driftReport(a!),
      ).toBeGreaterThan(1);
      if (!hasSynthPriors(id)) continue;
      // The non-tautological door: an expanding percentile pins HOW MANY observations clear
      // the cut, never WHEN. A series decaying out of its own regime drags the cut after it
      // and leaves every crossing at the OLD end of the fitting window — so requiring the
      // last crossing to land in the RECENT HALF is a question the percentile cannot answer
      // for itself, and the one that revokes under the ratcheting scenario the F3 note warns
      // about.
      expect(
        a!.lastCrossing !== undefined && a!.lastCrossing >= a!.regimeMid,
        `EXEMPTION REVOKED — ${id} ("${why}") last crossed its measured cut ` +
          `${JSON.stringify(a!.cuts)} on ${a!.lastCrossing ?? "never"}, in the OLDER half of ` +
          `the seed-depth window that cut is fitted over (midpoint ${a!.regimeMid}). ` +
          `The percentile has ratcheted down with the regime: it still reports ` +
          `${a!.regimeStates.join("/")} by construction, but the id has not signalled in the ` +
          `half of the history that is still current.\n` + driftReport(a!),
      ).toBe(true);
    }
  });

  it("reports truncated-feed ids as UNOBSERVABLE rather than failing them", () => {
    // DEAD-IN-WINDOW ≠ DEAD. Keyless FRED clamps the ICE BofA OAS series to a rolling ~3y,
    // so a 3y drift window over them establishes nothing. Pinned here to keep a future
    // "simplification" from folding them into the failing branch and making the guard a
    // false-positive machine.
    for (const id of ["F2", "F10", "CCC"]) {
      const a = byId.get(id)!;
      expect(a.status).toBe("UNOBSERVABLE");
      expect(a.reason).toMatch(/rolling ~3y/);
    }
  });

  // F1 is the contrast case: same ICE BofA feed, but a pre-clamp vintage was archived, so it IS observable when
  // that file is present — proving the UNOBSERVABLE branch is a data property, not an id skip.
  it.skipIf(readVintageText() === undefined)("F1 is observable off its archived vintage", () => {
    expect(byId.get("F1")!.status).not.toBe("UNOBSERVABLE");
  });
});
