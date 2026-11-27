// Per-indicator "which ladder legs does this hit" seam.
//
// `MEMBER_WEIGHT` (src/danger-ladder.ts) is the cross-leg magnitude of each scored member on each of
// the 9 ladder sleeves; `/api/danger-model` serves it verbatim as `memberWeight` (src/api/types.ts
// `DangerModel`). Derive the leg list from that served row — never hand-type a roster mirroring it
// (the drift class `testing-project.md` calls a defect).
//
// DOM-free + `.js` so vitest collects it and tsc ignores it (frontend.md); it returns STRUCTURE,
// never markup, so the caller escapes the sleeve names at its own render site.
//
// Tiering is RELATIVE TO THE ROW'S OWN MAX, never against an absolute constant — the weights are the
// engine's to retune, and an absolute cut here would be a second source of that tuning. A row
// therefore always has a non-empty top tier.

/** Fraction of the row max at or above which a leg is "hit hardest". */
const TOP_FRAC = 0.9;
/** Fraction of the row max at or above which a leg is "also material" (below TOP_FRAC). */
const MID_FRAC = 0.55;

/**
 * Rank one member's ladder exposure into three tiers.
 *
 * @param {Record<string, number>|undefined|null} row  `memberWeight[id]` off /api/danger-model —
 *   sleeve name → magnitude. Absent (a member with no row, e.g. a context-only id) ⇒ `null`.
 * @returns {{top: string[], mid: string[], low: string[]}|null} sleeve names per tier. Order
 *   within a tier is the row's own key order, which is the LADDER order (most-aggressive first)
 *   the server literal is written in and JSON preserves. Zero-weight sleeves are dropped: a 0 is
 *   the engine's "this member does not reach that leg" (`MEMBER_RELEVANCE` is exactly the non-zero
 *   support), not a weak hit.
 */
export function legImpactTiers(row) {
  if (!row) return null;
  const entries = Object.entries(row).filter(([, w]) => typeof w === "number" && w > 0);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, w]) => w));
  const tiers = { top: [], mid: [], low: [] };
  for (const [sleeve, w] of entries) {
    if (w >= TOP_FRAC * max) tiers.top.push(sleeve);
    else if (w >= MID_FRAC * max) tiers.mid.push(sleeve);
    else tiers.low.push(sleeve);
  }
  return tiers;
}

/**
 * The tiers as plain sentence CLAUSES ("hit hardest: …"), ready for a render site to escape and
 * join. Empty tiers are omitted; `null` in ⇒ `[]` out, so a member with no row renders nothing.
 *
 * @param {Record<string, number>|undefined|null} row
 * @returns {{label: string, sleeves: string[]}[]}
 */
export function legImpactClauses(row) {
  const tiers = legImpactTiers(row);
  if (!tiers) return [];
  return [
    { label: "hit hardest", sleeves: tiers.top },
    { label: "also material", sleeves: tiers.mid },
    { label: "least exposed", sleeves: tiers.low },
  ].filter((c) => c.sleeves.length > 0);
}
