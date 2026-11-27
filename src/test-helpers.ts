// Shared test fixtures. Lives in `src/` — NOT under `api/`, where any non-`*.test.ts`
// file becomes a Vercel Serverless Function and eats the Hobby 12-function cap that
// api/deploy-budget.test.ts guards. No prod consumers; imported only by *.test.ts.
import type { AlertRecord, StoredReading } from "./store.js";
import {
  applyCrisisGate,
  dialBandFor,
  LADDER_MAX,
  LADDER_MIN,
  targetRungFor,
  type T1DialResult,
} from "./t1dial.js";
import { notifyRegimeFor, regimeFor, rungCut } from "./families.js";
import { markProviderFallback } from "./provider-fallback-latch.js";

/** Default run_at used by makeAlert's firedAt — the commit point /status + /lab read. */
const TEST_RUN_AT = "2026-06-25T21:00:00.000Z";

/** A minimal StoredReading for `id` — GREEN on both ribbons, value 1, delta20 0; spread `over` to vary cells. */
export function makeStoredReading(id: string, over: Partial<StoredReading> = {}): StoredReading {
  return { date: "2026-06-25", indicatorId: id, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", ...over };
}

/**
 * A minimal, fully-populated AlertRecord whose firedAt === TEST_RUN_AT. Every field is
 * a NOT-NULL-safe placeholder; spread `overrides` to vary just the cells a test asserts on.
 */
export function makeAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    date: "2026-06-25",
    level: "OK",
    bandReason: "regime",
    fin: 0,
    rate: 0,
    geoFlags: 0,
    coincident: "GREEN",
    finReds: 0,
    firedAt: TEST_RUN_AT,
    pushedAt: null,
    pushError: null,
    degraded: [],
    nonLiveFamilies: null,
    slowScore: null,
    slowBand: null,
    slowMaxScore: null,
    bottomState: null,
    vix: null,
    vix3m: null,
    ratio: null,
    r4Phase: null,
    r4EntryFiredAt: null,
    r4ReentryRung: null,
    dialBand: null,
    dialState: null,
    displayDialState: null,
    panelState: null,
    heldSleeve: null,
    reriskConfirmCount: 0,
    heldDays: 0,
    cashOverlay: "off",
    cashOverlaySince: null,
    cashOverlayReason: null,
    dialTargetRung: null,
    // W5-d: 'indeterminate' + null/null is exactly what a degraded run writes and what the
    // migration defaults to — the today's-behaviour value, so no fixture inherits a live class.
    fallShape: "indeterminate",
    fallVelocity: null,
    creditDwellCloses: null,
    ...overrides,
  };
}

/**
 * The NON-danger cells a caller may set freely. `band` / `dangerScore` / `regime` / `notifyRegime`
 * are OUTPUTS of the danger input in `computeT1Dial` and are therefore excluded — hand-setting them
 * beside a `rung` is how the pre-2026-08-02 fixture produced books `computeT1Dial` can never emit
 * (calm `dangerScore 0` next to a firing `targetRung`). `rung`/`targetRung` are excluded here and
 * re-admitted by the union below, which allows exactly ONE of them.
 *
 * A test that genuinely needs the two regime axes to DISAGREE (production cannot — the two cut
 * tables coincide) spreads the result and overrides at the call site, where the divergence is
 * visible: `{ ...makeDial({ rung: 9 }), notifyRegime: "Caution" }`.
 */
type DialCells = Omit<
  Partial<T1DialResult>,
  "band" | "dangerScore" | "regime" | "notifyRegime" | "rung" | "targetRung"
>;

/**
 * The overrides `makeDial` accepts: the danger axis has exactly ONE free input, given EITHER as the
 * continuous `rung` OR as its integer alias `targetRung` — never both. The `never` legs make
 * `makeDial({ rung: 3, targetRung: 8 })` a tsc error rather than a silent drop of `targetRung`
 * (which is what the `over.rung ?? over.targetRung` read used to do).
 */
export type DialOverrides =
  | (DialCells & { rung?: number; targetRung?: never })
  | (DialCells & { targetRung?: number; rung?: never });

/**
 * A minimal T1DialResult, Calm (rung 1) by default. Spread `over` to vary a test's cells.
 *
 * The four derived fields are computed by CALLING the same production functions the dial's tail
 * calls (`rungCut` / `regimeFor` / `notifyRegimeFor` / `applyCrisisGate` and the real band
 * arithmetic) rather than by re-typing the formulas here — a local copy is the same drift class one
 * layer up. They are assigned AFTER the override spread so a caller cannot re-open it.
 *
 * `leaderSplit`/`coincidentSplit` are the band-WIDTH inputs (`firingSplit` on either axis); both
 * default to 0 — zero family disagreement ⇒ `lo === hi`, the case the width arithmetic already
 * admits — and a caller wanting a spread (e.g. the classic `{lo:1,hi:3}` at rung 3) passes 1.
 *
 * The danger input is ONE of `rung` (continuous, as the engine's own primitive is) or `targetRung`
 * (its integer alias) — the type makes passing both a compile error. `rung` is CLAMPED to
 * `[LADDER_MIN, LADDER_MAX]`, the same bound `computeT1Dial`'s tail applies, so a fixture cannot
 * emit a rung the engine can't reach. A `targetRung` alias is NOT clamped or rounded: it is
 * REJECTED unless it round-trips (`targetRungFor(rungCut(t)) === t`, i.e. an integer in ladder
 * range), because silently renormalising `{targetRung: 4.2}` to 4 is the quiet version of the
 * hand-set-derived-field defect this fixture exists to close. tsc cannot express "integer", so that
 * one guard is a runtime throw.
 *
 * `creditFiring`/`volatilityFiring` are the CRISIS-GATE inputs, and both default to false —
 * matching the `armed:false`/`fired:false` base book, i.e. no family panel. Consequence, and it is
 * the gate's whole point: a top-of-ladder rung alone does NOT buy the "Crisis" label
 * (`applyCrisisGate` demotes it to "Stress"), so a fixture that wants Crisis must say WHICH family
 * firing earns it — exactly the condition production requires.
 */
export function makeDial(
  over: DialOverrides = {},
  {
    leaderSplit = 0,
    coincidentSplit = 0,
    creditFiring = false,
    volatilityFiring = false,
  }: { leaderSplit?: number; coincidentSplit?: number; creditFiring?: boolean; volatilityFiring?: boolean } = {},
): T1DialResult {
  if (over.targetRung !== undefined) {
    const t = over.targetRung;
    // Round-trip through the production pair, PLUS the ladder bounds the round-trip alone cannot see
    // (rungCut/targetRungFor are inverses on every integer, in range or not: 12 → 1.375 → 12).
    if (targetRungFor(rungCut(t)) !== t || t < LADDER_MIN || t > LADDER_MAX) {
      throw new Error(
        `makeDial: targetRung ${t} is not an emittable rung - pass an integer in ` +
          `[${LADDER_MIN}, ${LADDER_MAX}], or use \`rung\` for a continuous value.`,
      );
    }
  }
  const rung = Math.min(LADDER_MAX, Math.max(LADDER_MIN, over.rung ?? over.targetRung ?? 1));
  const dangerScore = rungCut(rung);
  const targetRung = targetRungFor(dangerScore);
  return {
    leadingFiring: 0,
    coincidentFiring: 0,
    leadingP: 0,
    coincidentP: 0,
    techConfirmerP: 0,
    legP: 0,
    positionP: 0,
    armed: false,
    fired: false,
    shockOverride: false,
    systemicBump: 0,
    headline: "test dial",
    pillarsLive: true,
    fastBreakEW: false,
    graded: "coarse",
    ...over,
    rung,
    dangerScore,
    targetRung,
    regime: applyCrisisGate(regimeFor(dangerScore), creditFiring, volatilityFiring),
    notifyRegime: applyCrisisGate(notifyRegimeFor(dangerScore), creditFiring, volatilityFiring),
    band: dialBandFor(targetRung, Math.max(leaderSplit, coincidentSplit)),
  };
}

/** Latches a provider hop for exactly `symbol` (the router never hops itself).
 *  The caller owes `resetProviderFallbacks()` after — the latch is module state. */
export async function latchProviderFallbackViaRealHop(symbol: string): Promise<void> {
  markProviderFallback(symbol);
}
