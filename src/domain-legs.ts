/**
 * OR-leg evaluation + attribution (Stage 5c.3 leaf of the `domain-*.ts` split).
 *
 * The one place that knows which OR-legs exist per severity, which calibration
 * cut backs each, which fired on a given day, and how that reduces to
 * a drawn effective-cut line / a winning-leg label. Edges run ONE
 * way — this leaf imports `./domain-cuts.js` and `./domain-types.js` only.
 */
import type { Direction, FoldPolicy, Indicator, State, Thresholds } from "./domain-types.js";
import { CALIB_MAP, type CalibrationCuts } from "./domain-cuts.js";

/**
 * `indicatorProvenance` + the `Provenance` union lived here until 2026-07-30. RETIRED
 * with the wire field ("IS-3 consequence 2" [USER]): hand-set cuts are the permanent posture, so a
 * per-run `measured`/`proxy`/`convention` label carried no decision-relevant information
 * and its `measured` value was a standing false claim on the front end.
 */

/**
 * The nine leg ids in `winningLeg` attribution order (D1): eight OR-legs a severity tier tests, plus
 * `vel-z-slow`, a composite-only attribution token that `legBounds`/`evaluateLegs` never emit.
 * `vel-z-fast` / `vel-z-slow` — the second Δ horizons (`velocitySigma.fastWindow`; BONOS's `velSlowWindow`) —
 * sit AFTER `vel-z`: on a day both windows breach, attribution names the primary-horizon leg.
 * `vel-cusum` — the one-sided CUSUM PERSISTENCE leg — joined 2026-08-08
 * and sits LAST: it is the slowest-moving
 * leg, so on a day where a single-window shock also fires, attribution should name the shock.
 * @internal
 */
export const LEG_ORDER = ["op", "vel-op", "evt", "z", "vel-evt", "vel-z", "vel-z-fast", "vel-z-slow", "vel-cusum"] as const;
export type LegId = (typeof LEG_ORDER)[number];

/**
 * Human phrase per winning OR-leg — the ONE wording both the backend push text and the
 * FE detail-ribbon tooltip render, so "which leg breached" cannot read one way in a
 * notification and another way on the chart. Lives here (the zero-import DAG root) rather
 * than in the FE, which is the newer consumer.
 * `public/chart-primitives.js` keeps its own literal copy — a browser module cannot import
 * from `src/` — and `public/chart-primitives.test.js` pins the two key-for-key identical.
 *
 * KEY GRAMMAR (E6): a key is either a
 * `LEG_ORDER` member, or a COMPOSITE — two or more `LEG_ORDER` members joined by `+` in
 * `LEG_ORDER` order, as `winningLeg` synthesizes it when an AND-fold fires on several legs.
 * Composite entries here are WORDING OVERRIDES, never a requirement: `legPhrase` renders any
 * well-formed composite by mapping its parts through this table, so a future AND-folded id
 * costs no entry on either side. `"op+vel-op"` carries a hand-ruled phrase only because that
 * exact wording was ruled (R3).
 * @internal
 */
export const LEG_PHRASE: Readonly<Record<string, string>> = {
  op: "level cut",
  evt: "EVT tail",
  z: "regime-z",
  "vel-op": "velocity cut",
  "vel-evt": "velocity EVT",
  "vel-z": "velocity-z",
  "vel-z-fast": "fast velocity-z",
  "vel-z-slow": "slow velocity-z",
  "vel-cusum": "sustained drift",
  "op+vel-op": "wide and widening",
};

/**
 * The ONE renderer for a `Reading.leg` value — a table hit wins; otherwise the value is treated
 * as a composite, split on `+`, each part mapped through `LEG_PHRASE` (an unmapped part falls
 * back to the raw part) and rejoined with `" and "`. Every wording surface routes through this
 * (`src/provisional.ts`, and the FE mirror in `public/chart-primitives.js` for the ribbon
 * tooltip / member-chip badge), so a composite key added by a future `FOLD_POLICY` entry reads
 * correctly with no table edit anywhere.
 */
export function legPhrase(leg: string): string {
  const hit = LEG_PHRASE[leg];
  if (hit !== undefined) return hit;
  return leg
    .split("+")
    .map((part) => LEG_PHRASE[part] ?? part)
    .join(" and ");
}

export type LegSeverity = "Amber" | "Red";

/**
 * The D3 population (§1): indicators in `registry.ts` carrying BOTH a level bound
 * (`amberLevel`/`redLevel`) AND a velocity bound (`amberVelocity`/`redVelocity`).
 *
 * Indicators carrying a velocity leg = the ten below plus the velocity-ONLY set `R2`/`R3`/`R4`,
 * `F9` and `F11` — the last two joined when their level axes were retired and so LEFT this list.
 * For a
 * velocity-only id EVERY fire is a velocity fire by construction, so "velocity rather than level"
 * carries zero information and a rule keyed on velocity would fire on 100% of its firings (the
 * tautology). The exclusion is definitional, not a tuning choice.
 *
 * SINGLE DEFINITION: this is the one canonical set (swap-guard.ts / velocity-attribution.ts, its
 * ex-consumers, were deleted 2026-08-15 with the legacy backtest cluster).
 *
 * ⚠ **`T10YIE`/`T5YIFR` carry a VELOCITY leg and are members of `DUAL_AXIS_IDS`.** Both are
 * `rates`-family, so their velocity leg reaches the dial and the push. `openapi.yaml`'s
 * `legAttribution[].id` enum is DERIVED-tested against `DUAL_AXIS_IDS` in `src/api/contract.test.ts` (enum-sync table).
 * ⚠ `CALM_2024`'s guard tripwire (0.1369) sits BELOW the Δ20d p90, so no test catches a retune back
 * into the sub-p90 zone. ⚠ `isRelevant`-rowless ≠
 * output-invisible — both ids reach the T1 dial + push via `DIAL_FAMILIES.rates` → `computeFamilyPanel`,
 * a DIFFERENT roll-up from the 9-leg engine.
 */
export const DUAL_AXIS_IDS = [
  // F9 left this set 2026-08-07 and F11 2026-08-08, both when their LEVEL axes were retired
  // (Stage 1 of each): a velocity-only id makes "fired via velocity" a tautology, which is exactly the
  // exclusion this set's docblock states above.
  // BAA10Y left 2026-08-11 when the indicator retired outright (series lives on as a CQS input).
  "F1", "F2", "F3", "F10",
  // CCC joined 2026-10-12: a level AND a Δ20 velocity pair.
  "CCC",
  // T10YIE/T5YIFR joined 2026-07-31 `[USER]` — they
  // carry BOTH a level and a velocity registry pair from that commit, so "via velocity" is
  // informative for them exactly as it is for the ids above (they are not velocity-ONLY).
  "T10YIE", "T5YIFR",
] as const;

/**
 * Membership view of `DUAL_AXIS_IDS`, built ONCE at module load. Every consumer
 * (`velocityFiringCount` here, `driverAxisNote` in notify_format.ts, `dualAxisFiringIds` in
 * api/lab.ts) previously rebuilt its own `new Set(DUAL_AXIS_IDS)` per call — and
 * `driverAxisNote` runs once per driver per push. Derived from the array above, so the
 * canonical list stays the single definition.
 */
export const DUAL_AXIS_ID_SET: ReadonlySet<string> = new Set<string>(DUAL_AXIS_IDS);

/**
 * Which CLASS a leg's units axis belongs to. Mirrors the exact grouping `effectiveCuts` uses
 * (`velocity || vel-sigma` vs `level || sigma`): the z legs are σ-scaled restatements of their OWN
 * axis, so `z` is a LEVEL z-score and `vel-z` is a VELOCITY z-score. Getting this wrong is the one
 * way attribution silently mis-classifies, so it is a named, tested function, not an inline filter.
 */
export function axisClass(
  axis: "level" | "velocity" | "sigma" | "vel-sigma" | "vel-cusum",
): "level" | "velocity" {
  return axis === "velocity" || axis === "vel-sigma" || axis === "vel-cusum" ? "velocity" : "level";
}

/**
 * The velocity-class legs, derived from `legBounds`' axis assignment (see `axisClass`).
 * `vel-cusum` is velocity-class because its accumulator is a running sum of VELOCITY z's — its
 * units are neither the raw Δw nor a single σ multiple, which is why it carries its own
 * `vel-cusum` axis rather than reusing `vel-sigma` (see `plotted` in `effectiveCuts`).
 */
const VELOCITY_LEGS: ReadonlySet<string> = new Set<LegId>([
  "vel-op",
  "vel-evt",
  "vel-z",
  "vel-z-fast",
  "vel-z-slow",
  "vel-cusum",
]);

/**
 * Whether a `Reading.leg` value (`winningLeg`'s output) is velocity-class.
 *
 * COMPOSITE-AWARE (E6): the value is split on `+` and ANY velocity-class part makes the whole
 * velocity-class — so `isVelocityLeg("op+vel-op")` is `true` as a CONSEQUENCE of the rule, not a
 * special case, and a future composite needs no edit here. Reachability is the argument: a
 * composite exists only where an AND-fold required its velocity part to fire, so the binary
 * question every consumer asks ("did velocity drive this?") answers `true`.
 *
 * Consequence accepted knowingly:
 * `driverAxisNote` (`src/notify_format.ts`) reads `" — via velocity"` for a Red that ALSO
 * required its level leg. The fuller wording is carried by `LEG_PHRASE`/`legPhrase` on the
 * `src/provisional.ts` body and the FE badge. Deliberately no third axis value —
 * `public/leg-attribution.js` renders "" for anything but `"velocity"`/`"level"`.
 */
export function isVelocityLeg(leg: string | undefined): boolean {
  return leg !== undefined && leg.split("+").some((part) => VELOCITY_LEGS.has(part));
}

/**
 * D3 Stage 2.2 — READ-ONLY DIAGNOSTIC. How many DUAL-AXIS ids are firing (confirmed state
 * non-GREEN) and attributed to a VELOCITY-class leg on this run.
 *
 * Deliberately NOT wired into band math: `alert-band.ts` must not reference this. Stage 2.2 only
 * measures the population Stage 3 would gate on, so the count can be observed in run logs before
 * any escalator exists. `leg` is undefined where raw disagrees with confirmed (attribution
 * suppressed) and on unscored/hand-built readings — those simply don't count.
 *
 * ⚠ CALLER OBLIGATION: pass EVERY reading set the run scored, not just the main one. `DUAL_AXIS_IDS`
 * spans channels — a `channel: "GLOBAL"` id appears only in `runAssemble`'s `globalReadings` —
 * so a caller that hands over the main array alone silently caps this count below its own
 * denominator (`DUAL_AXIS_IDS.length`) and reports a ratio that can never be reached.
 */
export function velocityFiringCount(
  readings: { indicator: { id: string }; state: State; leg?: string }[],
): number {
  return readings.filter(
    (r) => DUAL_AXIS_ID_SET.has(r.indicator.id) && r.state !== "GREEN" && isVelocityLeg(r.leg),
  ).length;
}

interface LegBound {
  leg: LegId;
  /**
   * The bound this leg tests: the measured cut, or (op legs only) the convention
   * threshold fallback. `undefined` ⇒ the leg is absent at this severity.
   */
  bound: number | undefined;
  /**
   * Whether `bound` is a calibration-sourced measured cut (inclusive ≥/≤ semantics)
   * rather than a convention threshold (strict >/<). Operative swapped cuts are
   * measured by definition (gate-passing, ② Decision 2).
   */
  measured: boolean;
  /**
   * Units axis the bound lives on: plotted level, delta20 velocity, σ (z-cut), or the CUSUM
   * accumulator (a running sum of velocity z's — its OWN axis, drawn by nothing today).
   */
  axis: "level" | "velocity" | "sigma" | "vel-sigma" | "vel-cusum";
}

/**
 * THE ONE resolution of the CUSUM WARNING limit `h` (2026-08-09) — the `vel-cusum` leg's AMBER
 * bound in `legBounds` below, and the amber band the detail chart draws on the S⁺ axis
 * (`chart-rail.ts`). Trivial by design: its whole job is to be the single `cusumH` READ in the
 * tree, so a grep for the field returns exactly this line.
 * @internal
 */
export function cusumAlarmBound(
  cfg: NonNullable<Thresholds["velocitySigma"]>,
): number | undefined {
  return cfg.cusumH;
}

/**
 * THE ONE resolution of the CUSUM ACTION limit `h_red` (2026-08-09 §3.6a) — the `vel-cusum` leg's
 * RED bound in `legBounds` below, the red band on the S⁺ axis, AND the reset point of the
 * recurrence itself (`velocityCusumSeries`, domain-fold.ts, FIR-restarts `S⁺` to `h/2` on this crossing). A reset
 * keyed off a second copy of the number would let the accumulator re-arm on a day the RED leg did
 * not fire (or ratchet through one it did), with every test green.
 * @internal
 */
export function cusumRedBound(
  cfg: NonNullable<Thresholds["velocitySigma"]>,
): number | undefined {
  return cfg.cusumHRed;
}

/**
 * THE presence gate for the whole CUSUM persistence leg (2026-08-09, F11 ruling 5). Before it,
 * four consumers keyed off the presence of `velocitySigma` itself, so a σ id could not decline the
 * leg — the knobs were required fields. They are optional as a TRIPLE now, and this is the one
 * place that decides whether the leg exists: all three present ⇒ the leg folds, scores, wires and
 * draws; any missing ⇒ every one of those is off together. Resolving them jointly is what keeps a
 * half-declared block from folding an accumulator no leg reads (or drawing a band with no fold).
 *
 * Each bound still arrives through its ONE reader (`cusumAlarmBound`/`cusumRedBound`), so a retune
 * moves the fire test, the reset point and the drawn line together — this only bundles them.
 */
export function cusumParams(
  cfg: NonNullable<Thresholds["velocitySigma"]>,
): { k: number; alarm: number; red: number } | undefined {
  const alarm = cusumAlarmBound(cfg);
  const red = cusumRedBound(cfg);
  if (cfg.cusumK === undefined || alarm === undefined || red === undefined) return undefined;
  return { k: cfg.cusumK, alarm, red };
}

/**
 * THE OR-leg inventory (D1): the one place that knows which legs exist per severity,
 * which calibration cut backs each, and each leg's convention fallback. `classify`,
 * `winningLeg` and `effectiveCuts` are both reductions over
 * this list (the per-day ones via `evaluateLegs`), so adding a calibration leg is ONE
 * edit here instead of five synchronized ones. `t` is optional because cut-presence
 * callers have no Thresholds in scope — the op legs'
 * convention fallbacks are then simply absent.
 */
function legBounds(severity: LegSeverity, cuts?: CalibrationCuts, t?: Thresholds): LegBound[] {
  const amber = severity === "Amber";
  const op = amber ? cuts?.opAmber : cuts?.opRed;
  const velOp = amber ? cuts?.velOpAmber : cuts?.velOpRed;
  const evt = amber ? cuts?.evtAmber : cuts?.evtRed;
  const zCut = amber ? cuts?.zAmber : cuts?.zRed;
  const velEvt = amber ? cuts?.velEvtAmber : cuts?.velEvtRed;
  const velZCut = amber ? cuts?.velZAmber : cuts?.velZRed;
  // ROLLING-σ VELOCITY AXIS.
  // `Thresholds.velocitySigma` present ⇒ the registry velocity pair is in σ units, so it
  // must back the `vel-z` leg (compared against the day's z) and must NOT back `vel-op`
  // (compared against the raw Δw) — a single-digit σ multiple read as index points would fire on
  // almost every close. This routing is the whole reason the discriminator lives on `Thresholds`: it is
  // the only object `legBounds` is handed. Note the `vel-z` comparison is ≥ whether or not
  // the bound is measured (`velZLeg` in `evaluateLegs`), so a σ-convention pair does NOT
  // pick up the strict `>` the op legs' conventions use — a boundary-day-only difference.
  const velConvention = amber ? t?.amberVelocity : t?.redVelocity;
  const velSigma = t?.velocitySigma !== undefined;
  // The CUSUM leg is gated on the RESOLVED knob triple, never on `velocitySigma` presence — a σ id
  // may take the speed leg alone (F11, ruling 5). `velSigma` above is the UNITS discriminator and
  // stays keyed on presence: it decides whether the registry pair is σ multiples, which is true of
  // a cusum-less σ id too.
  const cusumCfg = t?.velocitySigma ? cusumParams(t.velocitySigma) : undefined;
  // ⛔ UNITS GATE (review suggestion, 2026-08-08). A measured `velZAmber/velZRed` — resolved from a
  // published `<prefix>_zscore_*` row — is the ONE calibration cut that lands on this same `vel-z`
  // leg and is compared against the day's z. For a σ id that z is a σ multiple, so a raw-unit
  // `_zscore_` row would win (`velZCut ??`) and compare index points against σ. Fail loud instead
  // of silently dominating. (`evt_vel_*` / `operative_vel_*` rows are NOT this hazard: they back
  // `vel-evt`/`vel-op` against the RAW `delta20`, which is correct units — the risk there is an
  // extra OR-leg escalating the day, not a unit mismatch.)
  if (velSigma && velZCut !== undefined) {
    throw new Error(
      `legBounds: a velocitySigma id resolved a measured velZ cut (${velZCut}) - the registry pair ` +
        `is in σ units and the calibration row is in series units; they cannot share the vel-z leg`,
    );
  }
  return [
    {
      leg: "op",
      bound: op ?? (amber ? t?.amberLevel : t?.redLevel),
      measured: op !== undefined,
      axis: "level",
    },
    {
      leg: "vel-op",
      bound: velOp ?? (velSigma ? undefined : velConvention),
      measured: velOp !== undefined,
      axis: "velocity",
    },
    { leg: "evt", bound: evt, measured: evt !== undefined, axis: "level" },
    { leg: "z", bound: zCut, measured: zCut !== undefined, axis: "sigma" },
    { leg: "vel-evt", bound: velEvt, measured: velEvt !== undefined, axis: "velocity" },
    {
      leg: "vel-z",
      bound: velZCut ?? (velSigma ? velConvention : undefined),
      measured: velZCut !== undefined,
      axis: "vel-sigma",
    },
    // THE FAST OR-ARM: present iff the σ block declares
    // `fastWindow`; compared against the SAME σ-multiple pair, so the tier fires on max(z, zFast).
    {
      leg: "vel-z-fast",
      bound: t?.velocitySigma?.fastWindow !== undefined ? velConvention : undefined,
      measured: false,
      axis: "vel-sigma",
    },
    // THE CUSUM PERSISTENCE LEG. Present iff the
    // id standardizes its velocity axis AND declares the knob triple (`cusumParams`) — S⁺ is
    // defined only where z is, but a σ id may still decline it (F11) — and TWO-TIER since
    // 2026-08-09 §3.6a: the SPC warning limit at AMBER (`cusumAlarmBound`) and the action limit at
    // RED (`cusumRedBound`), each the ONE reader of its field (see their docblocks). No
    // calibration row backs either: both are registry constants, so `measured` is false and the
    // comparison is the inclusive `≥` their docblock states. The bounds are in ACCUMULATOR units, so
    // `plotted` (effectiveCuts) must never draw them on the Δw axis — the `vel-cusum` axis value
    // is what keeps them out of both of that filter's branches.
    {
      leg: "vel-cusum",
      bound: amber ? cusumCfg?.alarm : cusumCfg?.red,
      measured: false,
      axis: "vel-cusum",
    },
  ];
}

interface EvaluatedLeg extends LegBound {
  fired: boolean;
}

/**
 * WHICH OR-legs this indicator's scorer actually tests, in `LEG_ORDER` — the same reduction over
 * `legBounds` that `classify`/`evaluateLegs` perform, minus the per-day values. A leg is present
 * iff it has a bound (a resolved calibration cut, or an op leg's convention fallback); an absent
 * bound never fires, so it is not part of the scorer.
 *
 * This exists so the detail chart's legend can NAME the live legs instead of restating them in
 * prose — the 2026-07-23 F1 retune closed `evtLevel` and the hand-written "level/velocity + EVT +
 * regime-z" legend kept advertising a leg that no longer scored. `/api/series` serves this and the
 * FE renders it through `LEG_PHRASE`, so a `CALIB_MAP`/vintage change moves the copy by itself.
 *
 * Note the z legs carry one further RUNTIME condition this cut-presence view cannot see: they fire
 * only where a z is defined for the day (a live own/proxy zref). A published z-cut with a
 * degenerate zref is listed here but scores nothing.
 */
export function activeLegs(indicator: Indicator, cuts?: CalibrationCuts): LegId[] {
  const live = new Set<LegId>();
  for (const severity of ["Amber", "Red"] as const)
    for (const l of legBounds(severity, cuts, indicator.thresholds))
      if (l.bound !== undefined) live.add(l.leg);
  return LEG_ORDER.filter((l) => live.has(l));
}

/**
 * Per-leg amber/red bound VALUES for the same legs `activeLegs` lists — the detail-chart caption's
 * data source for PRINTING the cut values when no cut line is in frame,
 * so the client never hardcodes a cut.
 * Same presence rule as `activeLegs` (a RAW bound at either severity — presence never depends on
 * the zref inversion below); a severity whose bound is absent is `null`. Keys in `LEG_ORDER` order.
 *
 * Units are the PLOTTED axis's units for every non-null value — the client formats each `vel-*`
 * bound with the Δ-axis formatter and each level bound with the level formatter, so nothing may
 * be served in σ multiples or accumulator units. σ-axis bounds are inverted through their
 * reference distribution exactly as `effectiveCuts`' `zCutLevel` does: the level `z` leg via
 * `zrefMean`/`zrefStd` (`mean ± cut·std`, sign by direction), the `vel-z`/`vel-z-fast` legs via
 * `velZrefMean`/`velZrefStd` (sign always +, velocity axes are HIGH-polarity — same rule as
 * `effectiveCuts`); a degenerate/absent zref yields `null`, never a spurious 0. `vel-cusum` has
 * NO image on the plotted Δ axis at all (its bounds sit on an accumulated sum of z's — see the
 * ⛔ note inside `effectiveCuts`), so both its severities are served `null`, the leg staying
 * present.
 */
export function activeLegBounds(
  indicator: Indicator,
  cuts?: CalibrationCuts,
): Partial<Record<LegId, { amber: number | null; red: number | null }>> {
  const high = (indicator.direction ?? "HIGH") !== "LOW";
  const invert = (bound: number, sign: 1 | -1, mean?: number, std?: number): number | null =>
    mean === undefined || std === undefined || std <= 0 ? null : mean + sign * bound * std;
  const value = (l: LegBound): number | null => {
    if (l.bound === undefined) return null;
    // No plotted-axis image (see the ⛔ vel-cusum note in `effectiveCuts`): the leg stays
    // present, but serving the accumulator limit as a Δ-axis number is a wrong number on screen.
    if (l.axis === "vel-cusum") return null;
    if (l.axis === "sigma") return invert(l.bound, high ? 1 : -1, cuts?.zrefMean, cuts?.zrefStd);
    // Velocity axes are always HIGH polarity (same rule as `effectiveCuts`' shared `high`).
    if (l.axis === "vel-sigma") return invert(l.bound, 1, cuts?.velZrefMean, cuts?.velZrefStd);
    return l.bound;
  };
  const present = new Set<LegId>();
  const bySev = { Amber: new Map<LegId, number | null>(), Red: new Map<LegId, number | null>() };
  for (const severity of ["Amber", "Red"] as const)
    for (const l of legBounds(severity, cuts, indicator.thresholds)) {
      if (l.bound !== undefined) present.add(l.leg);
      bySev[severity].set(l.leg, value(l));
    }
  const out: Partial<Record<LegId, { amber: number | null; red: number | null }>> = {};
  for (const leg of LEG_ORDER)
    if (present.has(leg))
      out[leg] = { amber: bySev.Amber.get(leg) ?? null, red: bySev.Red.get(leg) ?? null };
  return out;
}

/**
 * The ONE operative-pair separation predicate shared by both display paths
 * (the `/api/indicators` band resolve and `effectiveCuts` below): a pair is
 * usable only when BOTH legs are present AND strictly separated in oriented space
 * (`flip` negates orientation for a LOW-polarity LEVEL pair; velocity pairs never
 * flip). Rules out the degenerate amber==red collapse and any inversion, so an
 * unusable pair falls WHOLE to convention — never blended leg-by-leg.
 * @internal
 */
export function operativePairUsable(
  amber: number | undefined,
  red: number | undefined,
  flip: boolean,
): boolean {
  if (amber === undefined || red === undefined) return false;
  return (flip ? -amber : amber) < (flip ? -red : red);
}

/**
 * Per-day evaluation of every OR-leg at one severity — `classify` and `winningLeg`
 * (and through them the `rawStateSeries`/`winningLegSeries` folds) reduce over this.
 *
 * A bound fires when breached in its polarity direction; an absent bound never fires.
 * Velocity legs are always HIGH polarity (a fast rise is the shock) and compare the
 * cut against `delta20`, not `level`; only the level comparisons flip with
 * `direction` (R1 term spread is LOW). Measured cuts use INCLUSIVE ≥/≤ (ported from the
 * retired harness); convention thresholds stay strict >/<, so the op legs switch comparison
 * with their fallback (modes-and-markets ② Decision 2 — a present `op*` cut REPLACES
 * the convention leg for that band; absent ⇒ exact fallback). The z-leg negates for
 * LOW — fire when `(direction === "LOW" ? -z : z) ≥ cut` (ported from the retired `harness.py`'s
 * `sz = z if upper else -z`; reviewer I1). An undefined `z`/`velZ` skips those legs.
 * (The 2.0σ Red z-cut is methodology-consistent but was harness-validated only at the 1.5σ
 * Amber flag — reviewer I2.)
 */
export function evaluateLegs(
  severity: LegSeverity,
  level: number,
  delta20: number,
  t: Thresholds,
  direction: Direction,
  cuts?: CalibrationCuts,
  z?: number,
  velZ?: number,
  cusum?: number,
  velZFast?: number,
): EvaluatedLeg[] {
  const lvl = (b: number) => (direction === "LOW" ? level < b : level > b);
  const evt = (b: number) => (direction === "LOW" ? level <= b : level >= b);
  const vel = (b: number) => delta20 > b;
  const velEvt = (b: number) => delta20 >= b;
  const zLeg = (b: number) =>
    z !== undefined &&
    (direction === "LOW" ? -z : z) >= b;
  const velZLeg = (b: number) =>
    velZ !== undefined &&
    velZ >= b;
  const velZFastLeg = (b: number) =>
    velZFast !== undefined &&
    velZFast >= b;
  // The accumulator is one-sided and already signed by the z it sums, so — unlike `zLeg` — it
  // does NOT negate for a LOW id: a LOW `velocitySigma` id would owe a signed z at the source
  // (`velocitySigmaZSeries`), not a flip here. None exists today (F9 is HIGH).
  const cusumLeg = (b: number) =>
    cusum !== undefined &&
    cusum >= b;

  return legBounds(severity, cuts, t).map((l) => {
    if (l.bound === undefined) return { ...l, fired: false };
    const b = l.bound;
    let fired: boolean;
    switch (l.leg) {
      case "op":
        fired = l.measured ? evt(b) : lvl(b);
        break;
      case "vel-op":
        fired = l.measured ? velEvt(b) : vel(b);
        break;
      case "evt":
        fired = evt(b);
        break;
      case "z":
        fired = zLeg(b);
        break;
      case "vel-evt":
        fired = velEvt(b);
        break;
      case "vel-z-fast":
        fired = velZFastLeg(b);
        break;
      case "vel-cusum":
        fired = cusumLeg(b);
        break;
      default:
        fired = velZLeg(b);
    }
    return { ...l, fired };
  });
}

/**
 * THE combinator — how one severity's evaluated legs reduce to "did this tier fire, and which
 * legs own it". `classify`
 * (`domain-fold.ts`) and `winningLeg` below both reduce through this ONE implementation, so the
 * state and its attribution cannot disagree about the fold.
 *
 * Mode is the policy's field for this severity, `"or"` when absent (and when no policy at all is
 * supplied) — the shipped semantics.
 *  - `"or"`: the FIRST firing leg, as a one-element array, or `[]`. Behaviourally identical to
 *    the `.some()` / `.find()` this replaced.
 *  - `"and"`: every leg PRESENT at this severity (`bound !== undefined`) must fire. No present
 *    leg, or any present leg not firing ⇒ `[]`; otherwise ALL present legs, which `legBounds`
 *    already emits in `LEG_ORDER` order — so a caller may join them into a composite key without
 *    re-sorting. Absent legs are excluded rather than treated as non-firing, else an id would be
 *    unable to fire at all.
 */
export function foldFired(
  legs: EvaluatedLeg[],
  severity: LegSeverity,
  policy?: FoldPolicy,
): EvaluatedLeg[] {
  const mode = (severity === "Amber" ? policy?.amber : policy?.red) ?? "or";
  if (mode === "and") {
    const present = legs.filter((l) => l.bound !== undefined);
    return present.some((l) => !l.fired) ? [] : present;
  }
  const hit = legs.find((l) => l.fired);
  return hit ? [hit] : [];
}

/**
 * The *worst-of* (earliest-firing) cut per severity in the indicator's PLOTTED units,
 * so the detail chart can draw the exact level the full scorer (`classify`) tests
 * against as a flat dashed line. Mirrors `classify`'s OR-leg set (`classify` above)
 * but returns cut VALUES, not a boolean `State`, consuming the same `resolveCuts`
 * output without re-opening it (detail-band effective-line design correction #3).
 *
 * Units follow the plotted axis (transport contract): LEVEL for level ids
 * (R5/EBP), `delta20` for velocity-ONLY ids (R2/R3/R4 — `CALIB_MAP[id].legs`). The
 * velocity leg a level id may ALSO carry lives on the undrawn velocity axis
 * and is deliberately excluded from the level line (design correction #2); it still
 * surfaces per-day through `classify`'s attribution, not this scalar.
 *
 * "Worst-of" = the cut crossed FIRST as the indicator worsens: for a rising shock
 * (HIGH level, or any velocity leg) the SMALLEST cut (`min`); for a falling shock
 * (LOW level id, e.g. R1 inverted) the LARGEST (`max`). The z-cut is inverted back
 * into plotted units (`mean ± cut·std`, sign by `direction`) under `calibratedZ`'s own
 * `std > 0` guard, so a missing/degenerate zref drops the z-leg rather than treating it
 * as 0. An empty candidate set (no applicable cut this severity) ⇒ `null`.
 */
export function effectiveCuts(
  indicator: Indicator,
  cuts: CalibrationCuts,
): { effAmber: number | null; effRed: number | null } {
  const direction: Direction = indicator.direction ?? "HIGH";
  const t = indicator.thresholds;
  // Velocity-ONLY ids plot the velocity axis; an id carrying BOTH axes plots its LEVEL
  // line, its velocity leg staying off-axis (design correction #2, Stage 6.2a).
  const legs = CALIB_MAP[indicator.id]?.legs;
  const isVelocity = legs?.velocity === true && legs.level !== true;
  // Velocity axes are always HIGH polarity; only a LOW level id flips to `max`.
  const high = isVelocity || direction !== "LOW";

  // Display guard (operative-collapse fix): a degenerate/inverted/lone operative pair
  // falls WHOLE-pair to convention on the DRAWN line, via the shared
  // `operativePairUsable` — else
  // both band lines draw on one value and the area below lights red. Scoring
  // (`classify`/`evaluateLegs`) deliberately keeps the per-severity replacement
  // (② Decision 2): the guard changes where the line is drawn, not what fires.
  const guarded: CalibrationCuts = {
    ...cuts,
    ...(operativePairUsable(cuts.opAmber, cuts.opRed, direction === "LOW")
      ? {}
      : { opAmber: undefined, opRed: undefined }),
    ...(operativePairUsable(cuts.velOpAmber, cuts.velOpRed, false)
      ? {}
      : { velOpAmber: undefined, velOpRed: undefined }),
  };

  // Invert a z-cut back to plotted units — fire-level = mean ± cut·std, sign by
  // direction (HIGH ⇒ +, LOW ⇒ −), mirroring evaluateLegs' `(LOW ? -z : z) ≥ cut`.
  // Same guard as `calibratedZ` (needs mean/std, std > 0), so a degenerate/absent
  // zref drops the leg instead of contributing a spurious 0.
  const zCutLevel = (cut?: number, mean?: number, std?: number): number | undefined =>
    cut === undefined || mean === undefined || std === undefined || std <= 0
      ? undefined
      : mean + (high ? 1 : -1) * cut * std;

  const worstOf = (candidates: Array<number | undefined>): number | null => {
    const present = candidates.filter((c): c is number => c !== undefined);
    if (present.length === 0) return null;
    return high ? Math.min(...present) : Math.max(...present);
  };

  // The plotted axis keeps only its own legs: `delta20` units for velocity ids
  // (op/convention, EVT, own-series velocity z), LEVEL units otherwise — a level id's
  // off-axis velocity leg is deliberately excluded (design correction #2). σ-axis
  // bounds are inverted into plotted units via their reference distribution.
  // ⛔ The `vel-cusum` axis matches NEITHER branch of the filter below, deliberately: both its
  // bounds sit on an ACCUMULATED sum of z's, which has no image on the plotted Δw axis at all
  // (unlike `vel-sigma`, which `zCutLevel` can invert through a σ). Drawing one would put a flat
  // accumulator value on a Δ60 axis — a wrong number on screen. S⁺ is plotted on its own
  // secondary axis instead (`chart-rail.ts`).
  const plotted = (sev: LegSeverity): Array<number | undefined> =>
    legBounds(sev, guarded, t)
      .filter((l) => (isVelocity ? l.axis === "velocity" || l.axis === "vel-sigma" : l.axis === "level" || l.axis === "sigma"))
      .map((l) =>
        l.axis === "sigma"
          ? zCutLevel(l.bound, cuts.zrefMean, cuts.zrefStd)
          : l.axis === "vel-sigma"
            ? zCutLevel(l.bound, cuts.velZrefMean, cuts.velZrefStd)
            : l.bound,
      );

  return { effAmber: worstOf(plotted("Amber")), effRed: worstOf(plotted("Red")) };
}

/**
 * WHICH OR-leg drove a given day's state — the per-day companion to the per-cell
 * `effectiveCuts` scalar. `effectiveCuts` answers "where is the line"; this answers
 * "which leg crossed it today", so the detail-chart ribbon tooltip can explain a RED
 * whose plotted value sits inside the drawn line (an EVT/regime-z or an off-axis
 * velocity leg fired — the self-contradiction the band-line follow-up flagged).
 *
 * Walks the SAME `evaluateLegs` reduction as `classify` — RED tier before AMBER so a
 * red-firing day names its red leg — and returns the label of the FIRST leg that
 * fires: `op` (operative/convention level), `vel-op` (velocity op/convention), `evt`
 * (EVT tail), `z` (regime-z), `vel-evt`, `vel-z`, `vel-z-fast`, `vel-z-slow`, `vel-cusum` (`LEG_ORDER`). `undefined` when
 * GREEN. Sharing the one predicate implementation is what keeps the tooltip from
 * disagreeing with the ribbon color.
 *
 * Under an AND fold (`cuts.fold`, `FOLD_POLICY`) several legs jointly own the firing, and the
 * label is SYNTHESIZED from them — their ids joined by `+` in `LEG_ORDER` order (E6), e.g.
 * `"op+vel-op"`. So a future `FOLD_POLICY` entry on any id produces a well-formed, renderable
 * (`legPhrase`) label with zero code edits here. The return type stays `string | undefined`
 * rather than `LegId` (R3): a composite is not a leg with a bound, and no caller narrows.
 */
export function winningLeg(
  level: number,
  delta20: number,
  t: Thresholds,
  direction: Direction,
  cuts?: CalibrationCuts,
  z?: number,
  velZ?: number,
  cusum?: number,
  velZFast?: number,
): string | undefined {
  for (const sev of ["Red", "Amber"] as const) {
    const hit = foldFired(
      evaluateLegs(sev, level, delta20, t, direction, cuts, z, velZ, cusum, velZFast),
      sev,
      cuts?.fold,
    );
    if (hit.length > 0) return hit.map((l) => l.leg).join("+");
  }
  return undefined;
}
