/**
 * Tests for GET /api/families (body: meta-views.ts familiesView) — the ordered card grouping
 * the UI groups cards under: the 7 dial families, then the synthetic card-only zones. Guards the
 * render ORDER + that each entry serves key+label+desc+ids straight off DASHBOARD_FAMILIES +
 * CARD_ONLY_GROUPS (families.ts), so the browser can hand-declare nothing.
 */
import { describe, expect, test } from "vitest";

import { DASHBOARD_FAMILIES, CARD_ONLY_GROUPS } from "../src/families.js";
import { VINTAGE_HEADERS } from "../src/api/http.js";
import type { FamilyMeta } from "../src/api/types.js";

// Audit rank 14: the families handler folded into the meta router; its body is familiesView.
import { familiesView as GET } from "../src/api/meta-views.js";

const res = await GET();
const body = (await res.json()) as FamilyMeta[];

describe("GET /api/families", () => {
  // DERIVED: was 8 keys; `macro-cycle` was removed 2026-07-17 (DEC-22) ⇒ 7 in the same order.
  // `pension-drawdown` (2026-07-30) is the SYNTHETIC 8th entry — a CARD_ONLY_GROUPS display zone
  // that is NOT a dial family; it is served last so that zone's cards rank like the rest.
  test("returns the 7 families in render order, then the synthetic card-only zone", () => {
    expect(body.map((f) => f.key)).toEqual([
      "credit",
      "rates",
      "valuation",
      "volatility",
      "cross-asset",
      "trend",
      "geopolitics",
      "pension-drawdown",
    ]);
  });

  test("each family serves key + label + desc + ids from DASHBOARD_FAMILIES", () => {
    const familyCount = DASHBOARD_FAMILIES.length;
    expect(body.slice(0, familyCount)).toEqual(
      DASHBOARD_FAMILIES.map((f) => ({
        key: f.key,
        label: f.label,
        desc: f.desc,
        awaiting: f.awaiting,
        // E6(a) 2026-07-26: `ids` is served so every card surface can sort by impact rank
        // (`/api/indicators` is registry-ordered and cannot supply it). Widened 2026-07-30 to
        // the RENDER RANK: ranked members, then this family's CARD_ONLY_GROUPS overlay ids.
        // Derived, so this line pins WIRING — the order VALUES are pinned out-of-band in
        // families.test.ts; that ranked members LEAD the overlay tail is pinned at the
        // consumer (public/picker-groups.test.js).
        // Deduped the SAME way the producer dedupes (`new Set`, members first). A plain concat
        // here would be a second, wronger source: the day an overlay id is also a panel member
        // the producer is right to emit it once and this line would red falsely.
        ids: [
          ...new Set([...f.ids, ...CARD_ONLY_GROUPS.filter((g) => g.key === f.key).flatMap((g) => g.ids)]),
        ],
      })),
    );
    // The synthetic tail: every CARD_ONLY_GROUPS key that is NOT a dial family, in overlay order.
    expect(body.slice(familyCount)).toEqual(
      CARD_ONLY_GROUPS.filter((g) => !DASHBOARD_FAMILIES.some((f) => f.key === g.key)).map((g) => ({
        key: g.key,
        label: g.label,
        ids: [...g.ids],
      })),
    );
    // every DIAL family has a non-empty desc (the merged heading/column tooltip). The synthetic
    // card-only zone has none — CARD_ONLY_GROUPS carries key+label only — so it is out of scope
    // here rather than silently weakening the assertion for the seven that must have one.
    for (const f of body.slice(0, familyCount)) expect(f.desc).toBeTruthy();
    // ⚠ No "the served array is a COPY not an alias" assertion here: `body` is `res.json()`, so a
    // JSON round-trip has already produced fresh arrays and `not.toBe` would pass however
    // `meta-views.ts` was written — vacuous by construction. The `[...f.ids]` copy in the handler
    // stands on review, not on a pin this seam can carry.
  });

  // The two properties the `new Set([...members, ...overlay])` merge is FOR, asserted on the served
  // body rather than restated as an expression: an id appears ONCE in a render rank, and a ranked
  // member never falls behind an overlay id. Together they pin the collision case too — were an
  // overlay id ever also a member, emitting it twice would break the first and emitting it at the
  // overlay position would break the second, so the surviving rank is "once, at the member slot".
  test("each family's render rank has no duplicate id and keeps ranked members ahead of the overlay", () => {
    const checked: string[] = [];
    for (const f of DASHBOARD_FAMILIES) {
      const ids = body.find((b) => b.key === f.key)!.ids!;
      expect(new Set(ids).size, `${f.key}: duplicate id in the render rank`).toBe(ids.length);
      const overlay = CARD_ONLY_GROUPS.filter((g) => g.key === f.key).flatMap((g) => g.ids);
      // `>= 0` only: an id the rank does not carry is ABSENT, and `indexOf`'s −1 would otherwise
      // read as "rendered first" and red this line with the wrong message. Absence is the
      // `checked` floor's business, not the ordering assertion's.
      const memberPos = f.ids.map((id) => ids.indexOf(id)).filter((i) => i >= 0);
      const overlayPos = overlay
        .filter((id) => !f.ids.includes(id))
        .map((id) => ids.indexOf(id))
        .filter((i) => i >= 0);
      if (memberPos.length === 0 || overlayPos.length === 0) continue;
      checked.push(f.key);
      expect(Math.max(...memberPos), `${f.key}: members lead the overlay tail`).toBeLessThan(
        Math.min(...overlayPos),
      );
    }
    expect(checked, "families with both a member and an overlay half").toContain("volatility");
  });

  // `CARD_ONLY_GROUPS` may carry the SAME key twice (today: two `volatility` rows, VIX/VIX3M + VTP;
  // `credit` has NO row since EU2's 2026-09-05 removal). That is safe
  // ONLY because the duplicated key is also a DASHBOARD_FAMILIES key: `familiesView`'s member branch UNIONS every matching
  // overlay row into the one family entry, while its synthetic branch `.map`s row-by-row without
  // grouping. So a second row under a NON-family key (a second `pension-drawdown`) would serve TWO
  // entries with the same key, and `public/app.js` would render two identical headings each painting
  // the full card set. `src/api/types.ts` states the "one synthetic entry per non-family zone"
  // contract; nothing enforced it until this test.
  test("a duplicated CARD_ONLY_GROUPS key is always a dial-family key (synthetic zones stay unique)", () => {
    const seen = new Map<string, number>();
    for (const g of CARD_ONLY_GROUPS) seen.set(g.key, (seen.get(g.key) ?? 0) + 1);
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    // Vacuity guard: the rule is free unless some key IS duplicated today. If the duplication ever
    // goes away this fails and forces the guard to be re-justified rather than kept as dead weight.
    expect(duplicated, "no key is duplicated - this guard has nothing to bind").not.toEqual([]);
    for (const key of duplicated) {
      expect(
        DASHBOARD_FAMILIES.some((f) => f.key === key),
        `CARD_ONLY_GROUPS repeats the NON-family key "${key}" - familiesView's synthetic branch would serve it twice`,
      ).toBe(true);
    }
    // The served consequence, pinned on the body rather than argued: one entry per key.
    const keys = body.map((f) => f.key);
    expect(new Set(keys).size, `/api/families served a duplicate key: ${keys.join(", ")}`).toBe(
      keys.length,
    );
  });

  // The coverage-gap reason is served on `valuation` ONLY — live via ECY (US-only) since 2026-08-11,
  // `awaiting` now names the missing REGIONAL coverage, not a feedless stub. A blanket-applied field
  // would paint "awaiting feed — …" over every LIVE tile, so the single-family half is load-bearing.
  test("serves `awaiting` on the valuation family (regional-coverage gap) and on no other family", () => {
    expect(body.find((f) => f.key === "valuation")!.awaiting).toBe(
      "regional CAPE (EU / ex-US / EM): no keyless source. ECY covers US valuation only.",
    );
    for (const f of body.filter((f) => f.key !== "valuation")) {
      expect(f.awaiting).toBeUndefined();
    }
  });

  test("caches with the moderate poll TTL", () => {
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    expect(res.headers.get("Vercel-Cache-Tag")).toBe(VINTAGE_HEADERS["Vercel-Cache-Tag"]);
  });
});
