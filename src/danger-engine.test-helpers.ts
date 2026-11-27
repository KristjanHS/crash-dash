import type { State } from "./domain-types.js";
import type { FamilyPanel } from "./families.js";
import type { DangerInput } from "./danger-engine.js";
import { SUPER_GROUPS, type SuperGroup } from "./danger-ladder.js";

/** Wrap raw member states into the globalFamilies shape the engine reads (it flattens
 *  members across all panels, so a single panel suffices). Only `.members` is consulted. */
export function gf(members: { id: string; state: State }[]): DangerInput {
  const panel: FamilyPanel = {
    key: "credit",
    label: "",
    state: null,
    live: true,
    firing: false,
    contribution: null,
    absent: 0,
    // label is display-only; computeField reads id/state, so mirror id (stage 4.1 made label required).
    members: members.map((m) => ({ ...m, label: m.id })),
    note: undefined,
    desc: undefined,
  };
  return { globalFamilies: [panel] };
}

/** Super-groups with no EW/SN pillar: `CONFIRMING` (`uT`) enters leg danger as the GATED trend term and
 *  `EXOGENOUS` (`gp`) as the capped gp term of `legDangerShare` — outside the pillar means, never absent. */
export const NON_PILLAR_SUPER_GROUPS = new Set<SuperGroup>(["CONFIRMING", "EXOGENOUS"]);

/** The pillar-bearing super-groups, DERIVED ONCE from `SUPER_GROUPS`.
 *  Sites across the `danger-engine.*.test.ts` family
 *  used to write `["EARLY-WARN", "STRESS-NOW"]` out by hand, so a future pillar-bearing super-group would have joined none of them —
 *  silent UNDER-coverage, the same re-implementation-drift class already fixed once in F1's liveness guard.
 *  The engine already derives `CAPABLE_FAMILIES` from `SUPER_GROUPS`; only the tests hard-coded.
 *  Non-emptiness is guarded in `danger-engine.basics.test.ts`, describe "PILLAR_SUPER_GROUPS is derived,
 *  and non-vacuously so". */
export const PILLAR_SUPER_GROUPS: SuperGroup[] = SUPER_GROUPS.filter(
  (sg) => !NON_PILLAR_SUPER_GROUPS.has(sg),
);
