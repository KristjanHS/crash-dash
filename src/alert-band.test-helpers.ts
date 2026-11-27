/**
 * Shared fixtures for the two `alert-band.*.test.ts` halves (`.compose` and `.floors`).
 * NOT a `*.test.ts` name — vitest would collect this file as a suite.
 */
import { readFileSync } from "node:fs";
import { notifyRegimeFor, regimeFor, rungCut } from "./families.js";
import type { FamilyRegime } from "./families.js";
import { applyCrisisGate, LADDER_MIN, LADDER_MAX } from "./t1dial.js";
import type { T1DialResult } from "./t1dial.js";
import { makeDial } from "./test-helpers.js";
import { ALL_INDICATORS } from "./registry.js";
import type { Channel, Reading, State } from "./domain-types.js";

// --- escalatorFloor fixtures -----------------------------------------------
export const mkReading = (
  id: string,
  channel: Channel,
  state: State,
  confirmer = false,
): Reading => ({
  indicator: { id, label: id, longLabel: id, series: id, channel, thresholds: {}, confirmer },
  date: "2026-06-26",
  level: 1.23,
  delta20: 0.1,
  rawState: state,
  state,
});

/**
 * GEO fixtures bind to the SHIPPED registry descriptor — never a hand-written `Indicator` literal.
 * `mkReading` above invents its indicator, so a hand-built BRENT/OVX/G1 reading would carry NO
 * `geoFactor` and would exercise `autoGeoBase`'s untagged fallback (count as its own factor)
 * instead of the ruled factor-dedup path — the test would then pass for the wrong reason
 * (`testing-project.md`: derived fields come from the shipped config, never a hand-typed claim).
 * Every GEO fixture that depends on the factor count uses this.
 */
export const mkGeoReading = (id: string, state: State): Reading => {
  const indicator = ALL_INDICATORS.find((i) => i.id === id);
  if (!indicator) throw new Error(`no shipped indicator ${id}`);
  return { indicator, date: "2026-06-26", level: 1.23, delta20: 0.1, rawState: state, state };
};

// `fired` defaults TRUE so the 8 pre-W3-d call sites keep today's behavior; the unfired twins
// pass `false` explicitly. Without `armed`/`fired` here `dial.fired` reads undefined (falsy) and
// the W3-d gate would silently re-tier every computeAlertBand* test.
// W3-c: `computeAlertBandDetail` bands the NOTIFY axis, so `notifyRegime` must be set here or
// it reads undefined THROUGH THE CAST (tsc cannot see the missing field) and every band goes
// wrong. Both axes take the same value — these call sites predate the split and assert
// band composition, not cut divergence. To test a split axis, pass the two explicitly.
// ⚠ THE `as unknown as` CAST BELOW IS INVISIBLE TO tsc. Adding a required field to
// `T1DialResult` will NOT break this fixture at compile time — it breaks at RUNTIME, as
// `undefined` flowing into band math. W3-c proved it: adding `notifyRegime` turned 4 band
// tests red on a value read as `undefined`, while the two SIBLING dial fixtures
// (`dashboard.notify.test.ts`, `r4.test.ts`), both typed `Partial<T1DialResult> => T1DialResult`,
// failed at COMPILE time and were fixed before anything ran. The cast buys fixture brevity
// by opting out of exactly the check that would have caught the gap.
// Before adding a field to a widely-faked type, grep `as unknown as <Type>` across the
// suite — those sites are the ones that reach production-shaped paths with a hole.
// ── 2026-08-02: THE CAST IS GONE, and with it the hole the paragraphs above describe. ─────────
// `mkDial` no longer types a regime; it INVERTS the regime back to the rung that produces it and
// builds the whole book through the shared `makeDial`, so every field — including ones added to
// `T1DialResult` later — is populated by production rather than left `undefined` behind a cast.
// `creditFiring: true` earns the top label the crisis gate would otherwise demote, and matches the
// `armed: true` this fixture has always carried.
/**
 * The lowest ladder rung whose dangerScore scores `regime` on BOTH axes — the inverse of
 * `regimeFor`/`notifyRegimeFor`, computed by CALLING them over the ladder rather than by re-typing
 * the cut table (a hand map `{ Calm: 1, Caution: 3, … }` would be the same drift class one layer up,
 * and the two cut tables are allowed to diverge). Requiring BOTH axes is what keeps `mkDial`'s
 * single-label contract honest: these call sites assert band composition, not cut divergence.
 */
export const rungWhoseRegimeIs = (regime: FamilyRegime): number => {
  for (let r = LADDER_MIN; r <= LADDER_MAX; r++) {
    const score = rungCut(r);
    if (
      applyCrisisGate(regimeFor(score), true, false) === regime &&
      applyCrisisGate(notifyRegimeFor(score), true, false) === regime
    ) {
      return r;
    }
  }
  throw new Error(`no ladder rung scores ${regime} on both regime axes`);
};

// `fired` stays a positional arg; everything else is derived.
export const mkDial = (regime: FamilyRegime, fired = true): T1DialResult =>
  makeDial({ rung: rungWhoseRegimeIs(regime), armed: true, fired }, { creditFiring: true });

// --- D-B divergence escalator (Stage 2.2) --------------------------------------------
// The near-high tolerance is READ from the checked-in calibration source (the SAME file the
// vitest cut layer resolves from — effective-cuts.test.ts), never a hardcoded 1.0 copy, so
// its consumers track whatever `equity/qqq_nearhigh_tol` holds and can never drift from it.
export const NEARHIGH_TOL: number = (() => {
  const raw = JSON.parse(
    readFileSync(new URL("../scripts/backtest/calibration.json", import.meta.url), "utf8"),
  ) as { params: { channel: string; metric: string; value: number }[] };
  const row = raw.params.find((p) => p.channel === "equity" && p.metric === "qqq_nearhigh_tol");
  if (!row) throw new Error("qqq_nearhigh_tol missing from calibration.json - Stage 2.1 must land first");
  return row.value;
})();
