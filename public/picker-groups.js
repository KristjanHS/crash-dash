/** Family grouping for the two `<select>` indicator pickers — Zone D's `.ind-picker` and the
 *  replay `.erp-ind-picker`. This seam is what they share, giving ONE impact order across surfaces.
 *
 *  Grouping is `<optgroup>`, so the family heading is the browser's own, not CSS. This module
 *  emits DATA (`[{ key, label, items }]`); the two call sites own their markup, because their
 *  `<option>` label composition differs (Zone D shows `ID label`, replay shows the served
 *  `/api/series` label verbatim — `prose-names.test.ts` pins the latter against
 *  `api/replay.ts`'s COMPANIONS, so this seam must never rewrite a label).
 *
 *  Rank comes from `sortByFamilyOrder` — the same seam the cards use. Do not re-implement it here:
 *  one order, one sorter, or the surfaces drift again.
 */
import { sortByFamilyOrder } from "./family-order.js";

/** Group `metas` by family for an `<optgroup>` picker.
 *
 *  @param metas    `[{ id, label, family }]` — the `/api/indicators` shape. Registry-ordered.
 *  @param families `[{ key, label, ids }]` — the served `/api/families` list. Group order is
 *                  THIS array's order; member order inside a group is `ids` RENDER RANK (ranked
 *                  members, then card-only overlay ids — `FamilyMeta.ids`, meta-views.ts). That
 *                  list also carries the synthetic card-only zones (`pension-drawdown`), so no
 *                  caller passes a local zone table.
 *  @param opts.otherLabel heading for ids matching no served group. Emitted last.
 *  @param opts.lead       an already-built group to emit FIRST, ahead of every family
 *                         (the replay picker's external series, which are not registry ids).
 *
 *  Returns `[{ key, label, items }]` with empty groups dropped. Inputs are never mutated.
 *
 *  Degradation matters more than elegance here: `/api/families` is a separate serverless
 *  function, so a cold 500 leaves `families` empty — and a picker that paints NOTHING in that
 *  case is worse than an ungrouped one. Empty/missing `families` therefore yields one `Other`
 *  group holding every meta in incoming order (`app.js:921` guards Zone C the same way).
 */
export function groupMetasByFamily(metas, families, opts = {}) {
  const { otherLabel = "Other", lead = null } = opts;
  const list = Array.isArray(metas) ? metas : [];
  const fams = Array.isArray(families) ? families : [];

  const groups = [];
  if (lead && lead.items && lead.items.length) groups.push(lead);

  // A meta belongs to the FIRST bucket claiming its `family` key, so a key served twice can never
  // split one zone's cards across two headings.
  // Seeded from `lead` so an external series that ever shares an id with a registry indicator
  // renders ONCE, in the lead group, instead of twice. No live collision today
  // (VIXCLS/T10Y2Y/DCOILWTICO/^IXIC are none of them registry ids) — this closes the class.
  const claimed = new Set((lead && lead.items ? lead.items : []).map((m) => m.id));
  const emit = (key, label, ids) => {
    const items = sortByFamilyOrder(
      list.filter((m) => m.family === key && !claimed.has(m.id)),
      ids,
    );
    if (items.length === 0) return;
    items.forEach((m) => claimed.add(m.id));
    groups.push({ key, label: label ?? key, items });
  };

  for (const f of fams) emit(f.key, f.label, f.ids);

  const rest = list.filter((m) => !claimed.has(m.id));
  if (rest.length) groups.push({ key: "__other", label: otherLabel, items: rest });

  return groups;
}
