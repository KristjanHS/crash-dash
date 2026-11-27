/**
 * The ONE collapse-by-factor seam.
 *
 * Several indicators can read the SAME underlying factor — `G1` (WTI), `BRENT` and `OVX` all carry
 * `geoFactor: "oil"` in `registry.ts`. Counting them as three lit signals asserts breadth that does
 * not exist: it is one factor read three ways. Every surface that counts "how many things are lit"
 * must therefore count DISTINCT FACTORS, not rows.
 *
 * Two surfaces do: `autoGeoBase` in `alert-band.ts` (the escalator geo floor) and `diffusionLabel`
 * in `families.ts` (the push body + `/lab` breadth count). They used to spell the rule out
 * independently; this module is the single spelling so they cannot drift.
 *
 * ⚠ An UNTAGGED row falls back to its own id, i.e. it counts as its OWN factor — the pre-tag
 * behaviour, chosen so a missing tag can only ever be as loud as before, never silently soften a
 * floor or shrink a count. Scenario/replay rows synthesized from ids alone therefore behave exactly
 * as they did before the tag existed.
 *
 * ZERO imports on purpose: `families.ts` and `alert-band.ts` both reach it, and it must never be a
 * cycle edge.
 */

/**
 * The distinct factor KEYS among `items` — `factorOf(x)` when tagged, else `idOf(x)`.
 * Generic over the row shape so a `Reading` (factor = `indicator.geoFactor`, id = `indicator.id`)
 * and a family member (factor = `m.factor`, id = `m.id`) share one implementation.
 */
function factorKeysOf<T>(
  items: readonly T[],
  factorOf: (item: T) => string | undefined,
  idOf: (item: T) => string,
): Set<string> {
  return new Set(items.map((item) => factorOf(item) ?? idOf(item)));
}

/** `factorKeysOf(...).size` — the count callers actually want. */
export function distinctFactorCount<T>(
  items: readonly T[],
  factorOf: (item: T) => string | undefined,
  idOf: (item: T) => string,
): number {
  return factorKeysOf(items, factorOf, idOf).size;
}
