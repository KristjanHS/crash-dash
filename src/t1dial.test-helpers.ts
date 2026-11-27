import type { State } from "./domain-types.js";
import type { FamilyKey, FamilyPanel } from "./families.js";
import { TREND_COINCIDENT_DAMPING } from "./families.js";

export const CONTRIB: Record<State, number> = { GREEN: 0, AMBER: 0.5, RED: 1 };

export const mem = (id: string, state: State): { id: string; state: State } => ({
  id,
  state,
});

export const memL = (
  id: string,
  state: State,
): { id: string; label: string; state: State } => ({ id, label: id, state });

/** R2-1: the TREND family's `coincidentP` share — and
 *  only trend's — is damped. Every coincidentP expectation below is DERIVED through this helper so
 *  a retune of the factor moves them together; `trend-per-leg-gate.test.ts` pins only the RANGE
 *  (0 < f < 1) and the SHAPE (`contribution × f`). */
export const dampedTrend = (s: State): number => CONTRIB[s] * TREND_COINCIDENT_DAMPING;

/** Build one family panel; `live=false` models a dropped/stub family (excluded from L/K/p).
 *  `members` seeds per-member states (default []) for the techConfirmerFromPanel cases. */
export function panel(
  key: FamilyKey,
  state: State,
  live = true,
  members: { id: string; state: State }[] = [],
): FamilyPanel {
  // §3: the dial reads trend's band-depth from GT/GB members ONLY. A
  // state-only `trend` fixture (default empty members) models "the coincident trend regime fired",
  // so seed a GT member at that state — otherwise `coincidentContribution` sees no GT/GB and the
  // trend regime contributes 0. Explicit `members` (techConfirmerFromPanel cases) are left untouched.
  const seeded =
    key === "trend" && members.length === 0 ? [mem("GT", state)] : members;
  return {
    key,
    label: key,
    state: live ? state : null,
    live,
    firing: live && state !== "GREEN",
    contribution: live ? CONTRIB[state] : null,
    // label is display-only here (the dial reads id/state); mirror id (stage 4.1 made it required).
    members: seeded.map((m) => ({ ...m, label: m.id })),
    absent: 0,
  };
}

/** The 4 leading+coincident families live, GREEN unless overridden (credit+rates = ARM,
 *  volatility+trend = FIRE; cross-asset appended separately where a case needs it). */
export function build(overrides: Partial<Record<FamilyKey, State>> = {}): FamilyPanel[] {
  const keys: FamilyKey[] = ["credit", "rates", "volatility", "trend"];
  return keys.map((k) => panel(k, overrides[k] ?? "GREEN"));
}

/** build() + a cross-asset panel — needed for the shock override (vol+cross-asset+trend). */
export function buildXa(
  overrides: Partial<Record<FamilyKey, State>>,
  xa: State,
  xaLive = true,
): FamilyPanel[] {
  return [...build(overrides), panel("cross-asset", xa, xaLive)];
}
