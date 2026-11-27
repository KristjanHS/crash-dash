/**
 * The `/lab` half of the member-level diffusion count.
 *
 * Pure, DOM-free seam (the `tile-members.js` / `scoreboard-card.js` idiom): vitest collects it,
 * `tsc` (no allowJs) ignores it, and `diffusion-label.test.js` pins its output BYTE-IDENTICAL
 * against the TS formatter of record, `diffusionLabel` in `src/families.ts` — which the push body
 * (`notify_format.ts`) renders from. There is exactly one wording; this file is its browser twin,
 * not a second design. Any edit here that the parity test does not red is a divergence.
 *
 *   `1 red / 5 elevated of 6 (2 dark)`
 *
 * - ⚠ Every number counts DISTINCT FACTORS, not members: a member's factor is the served
 *   `m.factor` (the registry's `geoFactor`) falling back to `m.id`, so `gp`'s three oil reads
 *   (G1/BRENT/OVX) count as ONE. An untagged member is its own factor, so a payload from before the
 *   field shipped — and every family whose members are singly tagged — renders exactly as before.
 * - `red` = factors with ≥1 member at RED; `elevated` = factors with ≥1 member amber-or-worse — the
 *   ROSTER-wide member predicate, a SUPERSET of the family's own `firing` flag since D1
 *   (family-colour-follows-danger) narrowed `firing` to the band-driving set: this inner count can
 *   read `1 elevated` on a family the headline counts as not-firing. `elevated >= red` ALWAYS (the
 *   red factor set is a SUBSET of the elevated one); the pair is nested, never two independent populations.
 * - Denominator = the distinct factors among the present members (the population the worst-of
 *   actually folded over, collapsed the same way). The shrink
 *   is stated, not silent: `(N dark)` renders the served `absent`, OMITTED when `absent === 0`.
 *   `absent` is a ROSTER/MEMBER count and is deliberately NOT collapsed — it names how many roster
 *   ids did not report, a feed fact rather than a breadth claim.
 *   A payload carrying NO `absent` at all (a cached response served across the deploy that added
 *   the field) renders `(? dark)` — unknown, never the calm-looking `absent === 0` rendering: a
 *   defaulted 0 would print a shrunken denominator with no shrink stated, which is the exact
 *   behaviour §17.2 forbids. `diffusionLabel` cannot reach this case (`absent` is required on
 *   `FamilyPanel` and all three producers set it), so it is seam-only and outside the parity table.
 * - Zero present members renders `no members reporting` — reachable, since `applyFamilyCarry`
 *   re-marks a fully dropped family live+firing with `members: []`.
 *
 * ⚠ Input is the SERVED family panel — `f.members` and `f.absent` exactly as the server computed
 * them, never a display-pruned member list. The call site in `lab.js`
 * passes the **DIAL** panel (`d.dialFamilies[i]`, DIAL_FAMILIES — the population the push counts),
 * not the display panel `d.globalFamilies`; the two differ for `volatility` alone.
 */

/** Amber-or-worse — the member-level predicate `diffusionLabel` folds (NOT the band-scoped family
 *  `firing` flag since D1), spelled out because the browser seam cannot import `STATE_RANK`. RED and
 *  AMBER are the only amber-or-worse states (`STATE_RANK` = {GREEN:0, AMBER:1, RED:2}, src/domain-types.ts). */
function isElevated(state) {
  return state === "AMBER" || state === "RED";
}

/**
 * The diffusion label for a served family panel. Mirrors `diffusionLabel` (`src/families.ts`)
 * byte-for-byte; `diffusion-label.test.js` is the parity pin.
 */
export function diffusionText(f) {
  const raw = f ? f.absent : undefined;
  // Missing/garbled `absent` ⇒ UNKNOWN, not 0 (see the docblock): `(? dark)` says the shrink
  // cannot be quantified rather than silently asserting nothing is dark.
  const absent = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  const members = (f && f.members) || [];
  const dark = absent === null ? " (? dark)" : absent > 0 ? ` (${absent} dark)` : "";
  if (members.length === 0) return `no members reporting${dark}`;
  // `factor ?? id` — the browser twin of `distinctFactorCount` (src/geo-factor.ts), which the seam
  // cannot import. Same fallback, same nesting.
  const factors = (ms) => new Set(ms.map((m) => m.factor ?? m.id)).size;
  const red = factors(members.filter((m) => m.state === "RED"));
  const elevated = factors(members.filter((m) => isElevated(m.state)));
  return `${red} red / ${elevated} elevated of ${factors(members)}${dark}`;
}
