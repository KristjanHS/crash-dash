// Danger-scale brands/cuts and the #R2 concentration knobs, peeled from danger-engine.ts.

/** Compile-time scale brands (CORE-1, Stage 7.2): phantom tags, zero runtime cost, that stop the
 *  linear wsev SEVERITY scale and the share-lit DANGER scale from being banded by each other's
 *  cuts. A raw number is cast to a brand only at construction boundaries (these cut constants +
 *  `legRAG`'s `max(wsev)`); the brands are deliberately NOT threaded through internal signatures. */
export type Sev = number & { __scale: "sev" };
type Danger = number & { __scale: "danger" };
export const SEV_CUTS = { amber: 0.25, red: 0.75 } as Readonly<{ amber: Sev; red: Sev }>;
/** Share-lit danger-scale leg-RAG cuts (κ=0 walked fixed point); move FE `BAND_CUTS` in the same commit.
 *  Falsifier: `npx vitest run --silent=true public/sub-dangers.test.js`. Not `SEV_CUTS`, not `resolveCuts`. */
export const DANGER_CUTS = { amber: 0.3362, red: 0.5435 } as Readonly<{ amber: Danger; red: Danger }>;

/** #R2 sibling "elevated" LEVEL (= cuts.amber, a level — never collapse with the `RERISK_DEADBAND` distance). The badge
 *  reads `LEG_SENSITIVITY`-scaled sibling danger (`ownDanger`) while the board paints plain, so they may disagree by design. */
export const CONC_THRESHOLD = concThresholdOf(DANGER_CUTS);

/** #R2 elevated level at `cuts` — `shareArm` passes its own; `CONC_THRESHOLD` = this at `DANGER_CUTS`. */
export function concThresholdOf<C extends Readonly<{ amber: number }>>(cuts: C): C["amber"] {
  return cuts.amber;
}

/** Weight applied to a flagged leg's max-sibling-danger when computing effDanger for the auto-hold
 *  pick. Unitless attenuation ∈ [0,1] on an already-danger-scaled quantity ⇒ scale-invariant, so the
 *  rescale does not touch it. The own-danger bar stays unweighted/unchanged. */
export const CONC_WEIGHT = 0.6;
