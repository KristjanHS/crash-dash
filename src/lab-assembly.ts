/**
 * /lab shared assembly helpers: registry label maps, Reading reconstruction,
 * the lag knob, leg-history depth, and the prior-target / held-marker resolvers.
 */

import { ALL_INDICATORS } from "./registry.js";
import { type Indicator } from "./domain-types.js";
import { lagCutFor } from "./ladder.js";
import { rungOfSleeve } from "./families.js";
import { CADENCE_OF, type FeedLagNote } from "./feed-lag.js";
import { velocitySigmaDepth } from "./domain-fold.js";
import { VELOCITY_WINDOW, type Reading, type State } from "./domain-types.js";
import type { StoredReading } from "./store.js";
import type { FieldResult, MemberFreshness } from "./danger-engine.js";

/** id → registry DESCRIPTIVE long name (`Indicator.longLabel`). Lives HERE, not families.ts
 *  (registry-free by design); BOTH live and `?s=` panels use this one table (scenario↔live parity). */
export const LONG_LABEL_OF: Record<string, string> = Object.fromEntries(
  ALL_INDICATORS.map((i) => [i.id, i.longLabel]),
);

/** id → registry SHORT name (`Indicator.label`), rendered by the board's `legTitle`. Lives HERE, not
 *  families.ts; BOTH live and `?s=` paths use this one table (scenario↔live parity pin). */
export const LABEL_OF: Record<string, string> = Object.fromEntries(
  ALL_INDICATORS.map((i) => [i.id, i.label]),
);

/** id → its resolved `lagCutFor` — the absent-member carry gate (`assembleDial`'s `carryLagCutById`),
 *  mirroring run-cycle's `CARRY_LAG_CUT_BY_ID`. Values live in the registry + `lagCutFor`. */
export const LAB_CARRY_LAG_CUT_BY_ID: ReadonlyMap<string, number> = new Map(
  ALL_INDICATORS.map((i) => [i.id, lagCutFor(i)]),
);

/** Apply the SCENARIO-ONLY `?s=lag:<id>` knob: force each named id to `{ lag: true, label: "LAG" }`
 *  (the `◌` tier). Returns inputs UNCHANGED (same refs) when no id named, so a knob-free `?s=` stays
 *  byte-identical to live under the `expect(scenario.field).toEqual(live.field)` pin. */
export function applyLagKnob(
  freshness: readonly MemberFreshness[] | undefined,
  lag: readonly FeedLagNote[],
  forced: ReadonlySet<string>,
): { freshness: readonly MemberFreshness[] | undefined; lag: readonly FeedLagNote[] } {
  if (forced.size === 0) return { freshness, lag };
  const next = (freshness ?? []).map((f) => (forced.has(f.id) ? { ...f, lag: true, label: "LAG" as const } : f));
  const seen = new Set(next.map((f) => f.id));
  for (const id of forced) if (!seen.has(id)) next.push({ id, lag: true, label: "LAG" });
  const notes = lag.filter((n) => !forced.has(n.id));
  for (const id of forced)
    // `age`/`p90Gap`/`deepLagBar` stay NULL: the knob ASSERTS a classification, it does not measure one.
    notes.push({ id, label: "LAG", age: null, p90Gap: null, deepLagBar: null, lagCut: null, registered: CADENCE_OF.get(id) ?? "daily" });
  return { freshness: next, lag: notes };
}

/** Reconstruct the FULL `Reading[]` the walk's `assembleRun` core needs from persisted
 *  `StoredReading[]`. Maps each row through `ALL_INDICATORS`; an id with no indicator is dropped. */
export function reconstructReadings(rawReadings: StoredReading[]): Reading[] {
  const idToIndicator = new Map(ALL_INDICATORS.map((i) => [i.id, i]));
  return rawReadings.flatMap((sr) => {
    const indicator = idToIndicator.get(sr.indicatorId);
    if (!indicator) return [];
    return [
      {
        indicator,
        date: sr.date,
        level: sr.value,
        delta20: sr.delta20,
        rawState: sr.rawState,
        state: sr.state,
        decision: sr.decision ?? null,
      },
    ];
  });
}

/** Synthesize `Reading[]` from a family panel's member states (scenario compose has no persisted rows):
 *  each member becomes a confirmed reading at its `?s=` state. `levelOf` supplies the R4 tail levels for
 *  F1/VT; every other level is 0 (panels are STATE-driven, only the R4 tail gates read a level). */
export function readingsFromPanels(
  panels: readonly { members: readonly { id: string; state: State }[] }[],
  asOf: string,
  levelOf: (id: string) => number,
): Reading[] {
  const idToIndicator = new Map(ALL_INDICATORS.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: Reading[] = [];
  for (const fam of panels) {
    for (const m of fam.members) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const indicator = idToIndicator.get(m.id);
      if (!indicator) continue;
      out.push({
        indicator,
        date: asOf,
        level: levelOf(m.id),
        delta20: 0,
        rawState: m.state,
        state: m.state,
        decision: null,
      });
    }
  }
  return out;
}

// Extra leading history beyond the visible `hist` window, mirroring /series's LOOKBACK_PAD
// (api/series.ts) so reconstructed danger at t−N has its velocity lookback + confirm buffer.
export const LOOKBACK_PAD = 30;

// Stored-history depth for the read-time leg recompute. The plain recompute needs NO distributional
// window (`classify`/`winningLeg` are per-day over level+delta20, cuts from the persisted vintage); 60
// covers delta20 (VELOCITY_WINDOW=20) plus confirm-bootstrap slack. A ROLLING-σ id DOES need a window:
// `vel-z` is Δw/σ and σ needs `velocitySigmaDepth(cfg)` prior Δw (domain-fold.ts) each costing
// `velocityWindow` observations — too shallow and the leg degrades dark, recompute scores GREEN, and
// `attributeLeg` declines every firing day `recompute-disagreed`. THIRD consumer of that helper
// (`fred.ts`, `api/series.ts`) — never a second depth formula. HEADROOM is floor slack. Paid only by a
// firing σ id.
const LEG_HISTORY_LIMIT = 60;
const LEG_HISTORY_HEADROOM = 60;
export function legHistoryLimitFor(ind: Indicator): number {
  // ⚠ No descriptor-scored member in DUAL_AXIS_IDS since 2026-09-04. A future bespoke-scored
  // member must NOT take the plain 60: it needs its own depth checked FIRST and its own fold in
  // `attributeLeg` (the 2026-09-04 lesson — generic fold scored every day GREEN, declined every firing day).
  const sigma = ind.thresholds.velocitySigma;
  if (!sigma) return LEG_HISTORY_LIMIT;
  const w = ind.velocityWindow ?? VELOCITY_WINDOW;
  return Math.max(LEG_HISTORY_LIMIT, velocitySigmaDepth(sigma) + w + LEG_HISTORY_HEADROOM);
}

/** The rung implied by a persisted verdict's held sleeve (LADDER index+1, or `null`). Feeds
 *  `resolveR1View`. ⚠ NOT the `computeField` prior any more — see `prevDialTargetOf`. */
export function prevTargetOf(heldSleeve: string | null | undefined): number | null {
  return rungOfSleeve(heldSleeve ?? null);
}

/** The prior target rung `computeField`'s directional deadband compares against (M4/M8): the PERSISTED
 *  DIAL TARGET of the verdict this path read (same column `run-core.ts` hands the engine). `null` ⇒
 *  cold-start RISING, fail-safe. Must NOT be the held sleeve's rung — that ping-pongs the hold. */
export function prevDialTargetOf(verdict: { dialTargetRung?: number | null } | null | undefined): number | null {
  return verdict?.dialTargetRung ?? null;
}

/** The `held` marker must be the STATE-GATED sleeve that persisted + pushed (`verdict.heldSleeve`), NOT
 *  computeField's stateless pick. The `??` keeps computeField's held only when `heldSleeve` is null
 *  (degraded / pre-first-cron fail-safe). Load-bearing: surviving divergences are the TREND VETO and the
 *  deadband/prior-target asymmetry, so a same-states scenario must still deep-equal Live on `held`. */
export function gateHeld(field: FieldResult, heldSleeve: string | null | undefined): FieldResult["held"] {
  return heldSleeve ? field.legRows.find((l) => l.sleeve === heldSleeve) ?? field.held : field.held;
}
