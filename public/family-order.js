/** The Dashboard's read of the single-sourced indicator IMPACT ORDER.
 *
 *  `src/families.ts` orders every family's `ids` array strongest-first, and the `/lab` tiles get
 *  that order for free because they render the served family panel directly.
 *
 *  `/api/families` serves `ids` (openapi `FamilyMeta.ids`) and this seam applies it. It is a pure
 *  array transform so it can be pinned without a DOM (`frontend.md` §Testable slices go in a pure
 *  seam module).
 *
 *  ⚠ The two sets are NOT equal and neither contains the other: a family's `ids` can name a member
 *  the surface has no card for (a /lab-only member), and a cold `/api/families` leaves the caller
 *  with a fallback order whose entries have no `ids` at all. `/api/families` serves the whole render
 *  rank (card-only overlay + zones included); no local copy. So: unknown ids sort LAST, keeping their
 *  incoming relative order, and a missing/empty `ids` leaves the input untouched rather than shuffling it. */

/** Sort `metas` (each `{ id, … }`) into the family's impact order.
 *
 *  Returns a NEW array; the input is not mutated. Members absent from `ids` keep their incoming
 *  relative order and follow every ranked member — a stable partition, so an unranked card can
 *  never displace a ranked one. */
export function sortByFamilyOrder(metas, ids) {
  const list = [...metas];
  if (!Array.isArray(ids) || ids.length === 0) return list;
  const rank = new Map(ids.map((id, i) => [id, i]));
  // `Array.prototype.sort` is stable per spec (ES2019+), which is what preserves incoming order
  // inside each partition — the unranked tail relies on it, so do not swap in a manual swap-sort.
  return list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}
