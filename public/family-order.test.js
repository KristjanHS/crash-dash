/** E6(a) — the Dashboard's impact-order sort seam, and the SURFACE PIN that ties it to
 *  `src/families.ts`. Imports the TS source with an extensionless specifier, never `.js`
 *  (`frontend.md` §A `public/*.test.js` importing a TS module). */
import { describe, expect, test } from "vitest";

import { sortByFamilyOrder } from "./family-order.js";
import { DASHBOARD_FAMILIES } from "../src/families";

const metas = (...ids) => ids.map((id) => ({ id }));
const idsOf = (rows) => rows.map((r) => r.id);

describe("sortByFamilyOrder", () => {
  test("orders known ids by their position in the family's ids array", () => {
    expect(idsOf(sortByFamilyOrder(metas("F2", "F1", "F3"), ["F1", "F3", "F2"]))).toEqual(["F1", "F3", "F2"]);
  });

  test("ids absent from the rank sort LAST, keeping their incoming order", () => {
    // `ZZ`/`YY` are unranked; they must follow F1 and stay in the order they arrived.
    const out = sortByFamilyOrder(metas("ZZ", "F2", "YY", "F1"), ["F1", "F2"]);
    expect(idsOf(out)).toEqual(["F1", "F2", "ZZ", "YY"]);
  });

  test("no ids (a CARD_ONLY zone) leaves the input order untouched", () => {
    expect(idsOf(sortByFamilyOrder(metas("B", "A"), undefined))).toEqual(["B", "A"]);
    expect(idsOf(sortByFamilyOrder(metas("B", "A"), []))).toEqual(["B", "A"]);
  });

  test("does not mutate its input", () => {
    const input = metas("F2", "F1");
    sortByFamilyOrder(input, ["F1", "F2"]);
    expect(idsOf(input)).toEqual(["F2", "F1"]);
  });

  // SURFACE PIN (a) — the Dashboard. A registry-ordered card list run through the seam with the
  // real served `ids` must come back in DASHBOARD_FAMILIES order. Reversing the input is what
  // makes this non-vacuous: without the sort the assertion sees the reversed list.
  test("reproduces DASHBOARD_FAMILIES order for every family, from a scrambled input", () => {
    for (const fam of DASHBOARD_FAMILIES) {
      if (fam.ids.length === 0) continue; // `valuation` is feedless by design
      const scrambled = metas(...[...fam.ids].reverse());
      expect(idsOf(sortByFamilyOrder(scrambled, fam.ids)), fam.key).toEqual([...fam.ids]);
    }
  });
});
