import { describe, expect, it } from "vitest";
import { groupMetasByFamily } from "./picker-groups.js";
import { GLOBAL_FAMILIES, LADDER, SLEEVE_LABEL as BACKEND_LABEL, sleeveLabel as backendLabel, DASHBOARD_FAMILIES, CARD_ONLY_GROUPS, cardGroupOf } from "../src/families.ts";
import { SLEEVE_LABEL as FE_LABEL, sleeveLabel as feLabel } from "./sleeve-label.js";
import { INDICATOR_DESC } from "./indicator-desc.js";
import { familiesView } from "../src/api/meta-views.ts";
import { ALL_INDICATORS } from "../src/registry.ts";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.ts";

/** The served `/api/families` body, exactly as either picker receives it (picker heading parity
 *  section below). Module-level only because a describe body cannot `await`. */
const served = await (await familiesView()).json();

const meta = (id, family) => ({ id, label: `${id} label`, family });
const shape = (groups) => groups.map((g) => [g.label, g.items.map((m) => m.id)]);

describe("groupMetasByFamily", () => {
  it("emits groups in the served family order, members in ids rank", () => {
    const metas = [meta("F2", "credit"), meta("R1", "rates"), meta("F1", "credit")];
    const families = [
      { key: "credit", label: "Credit", ids: ["F1", "F2"] },
      { key: "rates", label: "Rates", ids: ["R1"] },
    ];
    expect(shape(groupMetasByFamily(metas, families))).toEqual([
      ["Credit", ["F1", "F2"]],
      ["Rates", ["R1"]],
    ]);
  });

  it("puts a family member absent from ids last, keeping incoming order", () => {
    const metas = [meta("ZZ", "credit"), meta("YY", "credit"), meta("F1", "credit")];
    const families = [{ key: "credit", label: "Credit", ids: ["F1"] }];
    expect(shape(groupMetasByFamily(metas, families))).toEqual([["Credit", ["F1", "ZZ", "YY"]]]);
  });

  it("emits zone groups after every family group, in zones order", () => {
    // The card-only zones are SERVED (meta-views.ts appends the synthetic
    // `pension-drawdown` entry), so a zone is just another entry in `families` and the separate
    // `zones` option is gone with `app.js`'s `CARD_ONLY_ZONES` hand-copy.
    const metas = [meta("SPY", "pension-drawdown"), meta("F1", "credit")];
    const families = [
      { key: "credit", label: "Credit", ids: ["F1"] },
      { key: "pension-drawdown", label: "Pension drawdown", ids: ["SPY"] },
    ];
    expect(shape(groupMetasByFamily(metas, families))).toEqual([
      ["Credit", ["F1"]],
      ["Pension drawdown", ["SPY"]],
    ]);
  });

  it("collects ids matching no served group into one trailing Other group", () => {
    const metas = [meta("NVDA", undefined), meta("F1", "credit"), meta("F7", "valuation")];
    const families = [{ key: "credit", label: "Credit", ids: ["F1"] }];
    expect(shape(groupMetasByFamily(metas, families))).toEqual([
      ["Credit", ["F1"]],
      ["Other", ["NVDA", "F7"]],
    ]);
  });

  it("honours a custom otherLabel and emits a lead group first", () => {
    const metas = [meta("F1", "credit"), meta("NVDA", undefined)];
    const families = [{ key: "credit", label: "Credit", ids: ["F1"] }];
    const lead = { key: "ext", label: "Market series", items: [{ id: "VIXCLS", label: "VIX" }] };
    expect(
      shape(groupMetasByFamily(metas, families, { lead, otherLabel: "Ungrouped" })),
    ).toEqual([
      ["Market series", ["VIXCLS"]],
      ["Credit", ["F1"]],
      ["Ungrouped", ["NVDA"]],
    ]);
  });

  it("a lead item sharing an id with a registry meta renders ONCE, in the lead", () => {
    const metas = [meta("VIXCLS", "volatility"), meta("R5", "volatility")];
    const families = [{ key: "volatility", label: "Volatility", ids: ["VIXCLS", "R5"] }];
    const lead = { key: "ext", label: "Market series", items: [{ id: "VIXCLS", label: "VIX" }] };
    expect(shape(groupMetasByFamily(metas, families, { lead }))).toEqual([
      ["Market series", ["VIXCLS"]],
      ["Volatility", ["R5"]],
    ]);
  });

  it("drops empty groups, including an empty lead", () => {
    const families = [
      { key: "credit", label: "Credit", ids: ["F1"] },
      { key: "valuation", label: "Valuation", ids: [] },
    ];
    const lead = { key: "ext", label: "Market series", items: [] };
    expect(shape(groupMetasByFamily([meta("F1", "credit")], families, { lead }))).toEqual([
      ["Credit", ["F1"]],
    ]);
  });

  it("claims each meta once - a key served TWICE does not duplicate its cards", () => {
    // The CARD_ONLY_GROUPS overlay reuses live family keys (VIX/VIX3M under `volatility`; the ids below are
    // a SYNTHETIC fixture, not the live roster), so a producer
    // slip could emit `credit` twice. The FIRST group wins; the card must not paint twice.
    const metas = [meta("BAA10Y", "credit"), meta("F1", "credit")];
    const families = [
      { key: "credit", label: "Credit", ids: ["F1", "BAA10Y"] },
      { key: "credit", label: "Credit (cards)", ids: ["BAA10Y"] },
    ];
    expect(shape(groupMetasByFamily(metas, families))).toEqual([["Credit", ["F1", "BAA10Y"]]]);
  });

  it("degrades to one Other group when /api/families is cold - never an empty picker", () => {
    const metas = [meta("F1", "credit"), meta("R1", "rates")];
    for (const cold of [[], undefined, null]) {
      expect(shape(groupMetasByFamily(metas, cold))).toEqual([["Other", ["F1", "R1"]]]);
    }
  });

  it("does not mutate its inputs", () => {
    const metas = [meta("F2", "credit"), meta("F1", "credit")];
    const families = [{ key: "credit", label: "Credit", ids: ["F1", "F2"] }];
    const metasBefore = metas.map((m) => m.id);
    const idsBefore = [...families[0].ids];
    groupMetasByFamily(metas, families);
    expect(metas.map((m) => m.id)).toEqual(metasBefore);
    expect(families[0].ids).toEqual(idsBefore);
  });

  it("groups the REAL served rosters by rank - no id lost, no id duplicated", () => {
    // Fed in REVERSE so an echo-the-input implementation fails: the assertion owns the order.
    const metas = GLOBAL_FAMILIES.flatMap((f) => f.ids.map((id) => meta(id, f.key))).reverse();
    const groups = groupMetasByFamily(metas, GLOBAL_FAMILIES);
    for (const g of groups) {
      const fam = GLOBAL_FAMILIES.find((f) => f.key === g.key);
      expect(g.items.map((m) => m.id), g.key).toEqual([...fam.ids]);
    }
    const emitted = groups.flatMap((g) => g.items.map((m) => m.id));
    expect(emitted.length).toBe(metas.length);
    expect(new Set(emitted).size).toBe(emitted.length);
  });
});

// ── SLEEVE_LABEL parity (ex-sleeve-label-parity.test.js) ───────────────────────────────────────
// CROSS-IMPLEMENTATION parity for the sleeve DISPLAY labels.
//
// `SLEEVE_LABEL` in src/families.ts names a sleeve in the push text; public/sleeve-label.js is its
// hand-kept browser twin (a browser module cannot import `src/`). Only the twin can drift silently —
// this file is what stops it. Same construction as the LEG_PHRASE parity pin (chart-primitives.test.js): the FE table is its own
// literal, so mutating either value reds here.
describe("SLEEVE_LABEL parity (src/families.ts ↔ public/sleeve-label.js)", () => {
  it("is entry-for-entry identical", () => {
    expect({ ...FE_LABEL }).toEqual({ ...BACKEND_LABEL });
  });

  it("every override is keyed on a LADDER sleeve, and both resolvers agree on every rung", () => {
    for (const key of Object.keys(FE_LABEL)) expect(LADDER).toContain(key);
    for (const sleeve of LADDER) expect(feLabel(sleeve)).toBe(backendLabel(sleeve));
  });

  it("passes non-ladder strings through unchanged (Cash, off-ladder ids, prototype names)", () => {
    for (const s of ["Cash", "SMH", "constructor", "toString"]) expect(feLabel(s)).toBe(s);
  });
});

// ── picker heading parity (ex-picker-heading-parity.test.js) ─────────────────────────────────
/** The SAME id must read the SAME heading in BOTH `<select>` pickers.
 *
 *  Every `CARD_ONLY_GROUPS` overlay id (`BAA10Y`, `VIX`/`VIX3M`, `DB_SMH`/`DB_XLK`, `F7`) and the
 *  whole `pension-drawdown` zone must group identically across the Dashboard's Zone D picker and the
 *  /lab replay picker: the producer appends the overlay to the served RENDER RANK and serves the
 *  zone synthetically, so neither picker keeps a local zone table.
 *
 *  This suite drives the REAL producer (`familiesView`) — not a hand-typed mirror of it — through
 *  the REAL grouping seam both pickers call, once per picker's own population + options.
 *  `frontend.md`: a `.test.js` importing TS uses an explicit `.ts`/extensionless specifier. */
describe("picker heading parity (E6(a) tail)", () => {
  /** Zone D (`app.js renderDetailTab`): `/api/indicators` metas, whose `family` is `cardGroupOf(id)`,
   *  grouped against the served list with no local zone table. */
  const zoneDGroups = groupMetasByFamily(
    // The served population is ALL_INDICATORS ∪ CHART_ONLY_INDICATORS (api/
    // indicators.ts maps that union) — mirror the handler's SET, or this fixture drifts from the
    // surface it claims to model and reports a chart-only id as "one picker doesn't offer it".
    [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => ({ id: i.id, label: i.label, family: cardGroupOf(i.id) })),
    served,
  );

  /** /lab replay (`lab.js companionOptions`): the eligible stored companions are `INDICATOR_DESC`
   *  keys, and lab.js derives each one's `family` from the SERVED ids (first group claiming it wins)
   *  because a replay option carries no server-attached family key. Externals lead. */
  const externals = [{ id: "VIXCLS", label: "VIX" }, { id: "T10Y2Y", label: "10y−2y" }];
  const familyOfServed = new Map();
  for (const f of served) for (const id of f.ids || []) if (!familyOfServed.has(id)) familyOfServed.set(id, f.key);
  const replayGroups = groupMetasByFamily(
    Object.keys(INDICATOR_DESC).map((id) => ({ id, label: id, family: familyOfServed.get(id) })),
    served,
    { lead: { key: "__ext", label: "Market series", items: externals }, otherLabel: "Other indicators" },
  );

  /** The heading an id renders under, or undefined when no group carries it. */
  const headingOf = (groups, id) => groups.find((g) => g.items.some((m) => m.id === id))?.label;

  // THE FALSIFIER of the ruling. Both sides are read off the rendered groups, and the expected
  // value is the served family LABEL — so dropping the overlay append at the producer sends the
  // replay side to "Other indicators" and the Zone D side nowhere, and this line goes red.
  it("CQS reads the same heading in the Zone D picker and the replay picker", () => {
    const creditLabel = DASHBOARD_FAMILIES.find((f) => f.key === "credit").label;
    expect(headingOf(zoneDGroups, "CQS")).toBe(creditLabel);
    expect(headingOf(replayGroups, "CQS")).toBe(creditLabel);
  });

  // The same claim across the WHOLE overlay + zone, so the pin is not one lucky id: every
  // CARD_ONLY_GROUPS id reads its group's own label on both surfaces.
  it("every card-only overlay id reads its group label on both surfaces", () => {
    expect(CARD_ONLY_GROUPS.flatMap((g) => g.ids)).toContain("VIX");
    for (const g of CARD_ONLY_GROUPS) {
      const label = served.find((f) => f.key === g.key).label;
      for (const id of g.ids) {
        for (const [surface, groups] of [["zoneD", zoneDGroups], ["replay", replayGroups]]) {
          expect(headingOf(groups, id), `${id} @ ${surface}`).toBe(label);
        }
      }
    }
  });

  // The synthetic zone: `pension-drawdown` is not a dial family, and it is exactly what `app.js`
  // used to hand-copy. Serving it is what let that copy go — so its cards must group under the
  // served label with NO local zone table passed to the seam.
  it("the synthetic pension-drawdown zone groups its cards with no local zone table", () => {
    const zone = CARD_ONLY_GROUPS.find((g) => g.key === "pension-drawdown");
    const group = zoneDGroups.find((g) => g.key === "pension-drawdown");
    expect(group?.label).toBe(zone.label);
    // Every one of that zone's ids that has a registry card lands there, in overlay rank.
    const carded = zone.ids.filter((id) => ALL_INDICATORS.some((i) => i.id === id));
    expect(group.items.map((m) => m.id)).toEqual(carded);
  });
});
