// Pins the board-leg tooltip composition (lab.js `legSpan` → `legTitle`). lab.js itself is not
// importable under vitest (module-level DOM side effects), so the composition lives in
// leading-name.js and is pinned here against the REAL MEMBER_HELP copy and the REAL registry
// names — not a hand-typed fixture that could drift from either.
// Plain `.js` so vitest's default glob collects it while `tsc` ignores it (frontend.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { legTitle, idIfDistinct } from "./leading-name.js";
import { MEMBER_HELP } from "./member-help.js";
import { legImpactTiers, legImpactClauses } from "./leg-impact.js";
// NB: `.ts` specifier (not the project's usual `.js`) — vitest resolves it, and this `.js`
// test is invisible to tsc, so the prod `.js`-extension rule does not apply here.
import { ALL_INDICATORS } from "../src/registry.ts";
import { GLOBAL_FAMILIES, LADDER } from "../src/families.ts";
import { MEMBER_WEIGHT } from "../src/danger-ladder.ts";

const ind = (id) => ALL_INDICATORS.find((i) => i.id === id);

describe("legTitle - short name first, then the help sentence, name emitted once", () => {
  // Post-4.2 the help copy is the bare sentence (its own "<label> — " clause was dropped), so the
  // tooltip is the short name prepended once ahead of it.
  it("prepends the label once, ahead of the bare help sentence", () => {
    const f13 = ind("F13");
    const title = legTitle(f13.label, MEMBER_HELP.F13);
    expect(title).toBe(`HYG/LQD - ${MEMBER_HELP.F13}`);
  });

  // `legTitle` no longer takes or renders the registry `longLabel` (it still ships on the wire), so a
  // member's long name must not appear in the tooltip. F13's long name differs from its short label,
  // so a regression that re-emitted longLabel would surface here.
  it("never renders the descriptive long name (dropped from the hover)", () => {
    const f13 = ind("F13");
    expect(f13.longLabel).not.toBe(f13.label); // the regime this test exists for
    const title = legTitle(f13.label, MEMBER_HELP.F13);
    expect(title).not.toContain(f13.longLabel);
  });

  // Scenario/replay members are synthesized from ids alone; the tooltip is still the label prepended
  // once ahead of the full help copy (this is the path that shipped before short-names step 2).
  it("degrades to `label - help`", () => {
    const r1 = ind("R1");
    // Before the 4.2 drop this happened to equal the untouched copy only because the copy already
    // opened with "10y−3m — "; now it is the label prepended once ahead of the bare sentence.
    expect(legTitle(r1.label, MEMBER_HELP.R1)).toBe(`${r1.label} - ${MEMBER_HELP.R1}`);
  });
});

// Stage 4.3 deleted `stripLeadingName`; legTitle now prepends the label and appends the help copy
// raw. The ↓ strip chips (SMH↓/NVDA↓/QQQ↓) keep a "Downside-break — " help clause that is NOT a
// label, so this case pins that legTitle passes it straight through — the whole help sentence,
// including its own internal separator, survives ahead of nothing being stripped.
describe("legTitle passes the ↓ strip-chip help through raw, prepending the label once", () => {
  it("prepends the label and keeps the full help clause, unsplit", () => {
    const help = "Downside-break - SMH broke its 200-day line";
    expect(legTitle("SMH", help)).toBe("SMH - Downside-break - SMH broke its 200-day line");
    // The help is appended raw — legTitle no longer splits, so the "Downside-break" clause survives.
    expect(legTitle("SMH", help)).toContain("Downside-break - ");
  });
});

// ── card tooltip composition (ex-card-tip.test.js) ─────────────────────────────────────────────
// Pins the main-dashboard card tooltip composition in app.js (`const cardTip = …`,
// renderCard). Two things must hold and had NO test before name-dup slice 4.2b:
//   1. the tooltip LEADS with "<id> <label> — " on BOTH branches — the explainer
//      branch (`desc.tip`, which as of 4.2b no longer carries its own leading name)
//      and the no-entry fallback branch ("<channel> channel"). Ruling (d): the
//      id/label prefix lives OUTSIDE the `??`, so the two branches share one shape.
//   2. the explainer text is appended verbatim (not double-prefixed).
//
// app.js has zero exports and boots the DOM on import (no jsdom in this suite —
// frontend.md), so it can't be imported. Sibling app.js tests (write-seam.test.js)
// read it as SOURCE text; this one goes one step further and EVALUATES the exact
// `cardTip` template RHS lifted from source, so the assertion is behavioral (it fails
// when the composed string changes) rather than a brittle text match.
describe("card tooltip composition (app.js cardTip)", () => {
  const SRC = readFileSync(fileURLToPath(new URL("./app.js", import.meta.url)), "utf8");

  // Lift the cardTip composition from source and run it. cardTip leads with a `const name = […idIfDistinct…]`
  // line (the id drops when it restates the label), so lift BOTH that line and the `const cardTip =` line and
  // evaluate them together, injecting the real `idIfDistinct` — the assertion stays behavioral.
  const lines = SRC.split("\n").map((t) => t.trim());
  const nameLine = lines.find((t) => t.startsWith("const name = [meta.label, idIfDistinct"));
  const cardTipLine = lines.find((t) => t.startsWith("const cardTip ="));
  if (!nameLine || !cardTipLine) throw new Error("could not locate cardTip composition in app.js");
  // eslint-disable-next-line no-new-func
  const composeCardTip = new Function("meta", "idIfDistinct", "desc", `${nameLine}\n${cardTipLine}\nreturn cardTip;`);

  const META = { id: "F1", label: "HY OAS", channel: "CREDIT" };

  it("leads with `<id> <label> - ` and appends the explainer tip", () => {
    const out = composeCardTip(META, idIfDistinct,{ tip: "the high-yield credit spread" });
    expect(out).toBe("HY OAS F1 - the high-yield credit spread Tap or click for history.");
  });

  it("falls back to `<channel> channel` with the SAME `<id> <label> - ` shape when no entry", () => {
    const out = composeCardTip(META, idIfDistinct,undefined);
    expect(out).toBe("HY OAS F1 - CREDIT channel Tap or click for history.");
  });
});

// ── MEMBER_HELP coverage (ex-member-help.test.js) ──────────────────────────────────────────────
// Coverage guard for the board-tile member tooltips. `legSpan` (lab.js) renders a leg's
// [title] ONLY when MEMBER_HELP has its id, so a member added to a family without an entry
// silently ships a tooltip-less chip.
// Mirrors indicator-desc.test.js: plain `.js` so vitest's default glob collects it while
// `tsc` ignores it (frontend.md), importing the real TS registry so a future member
// added without help copy fails `npm run check` instead of shipping.
describe("MEMBER_HELP coverage", () => {
  // The board renders GLOBAL_FAMILIES (the dial's panel), deduped across families.
  const MEMBER_IDS = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];

  /** MEMBER_HELP keys that are NOT indicator ids: the downside-break STRIP CHIPS, which are rendered
   *  off `d.downsideDetectors` and have no registry entry. Explicit, so an unmatched key is a
   *  FAILURE rather than a silently skipped row (which would make the label pin below vacuous). */
  const NON_REGISTRY_KEYS = ["SMH↓", "NVDA↓", "QQQ↓"];

  it("every GLOBAL_FAMILIES member id has a non-empty string hover-help entry", () => {
    const missing = MEMBER_IDS.filter((id) => typeof MEMBER_HELP[id] !== "string" || MEMBER_HELP[id].length === 0);
    expect(missing).toEqual([]);
  });

  // Completeness for the three ↓ STRIP-CHIP keys: they carry copy AND are deliberately NOT registry
  // ids (they render off `d.downsideDetectors`, not a family member). The leading-name === label pin
  // that used to live here was deleted in Stage 4.2 — the help copy no longer leads with the short
  // name (that clause was dropped; the render site prepends the name — leading-name.js).
  it("carries the non-registry strip-chip keys, which are absent from the registry", () => {
    const LABEL_OF = new Map(ALL_INDICATORS.map((i) => [i.id, i.label]));
    expect(NON_REGISTRY_KEYS.filter((k) => LABEL_OF.has(k))).toEqual([]);
    expect(NON_REGISTRY_KEYS.filter((k) => !MEMBER_HELP[k])).toEqual([]);
  });

  // The REVERSE direction of the first coverage pin in this describe, and the half of the deleted leading-name test
  // worth keeping: that pin catches a member with no copy, this catches copy with no member. Without it
  // an indicator retired from the registry leaves an orphan MEMBER_HELP entry that nothing reds.
  // (A *typo'd* id is caught either way — the real id then fails that pin — so this only guards dead copy.)
  it("carries no orphan copy: every non-exempt key is a live registry id", () => {
    const LABEL_OF = new Map(ALL_INDICATORS.map((i) => [i.id, i.label]));
    const orphans = Object.keys(MEMBER_HELP).filter((k) => !NON_REGISTRY_KEYS.includes(k) && !LABEL_OF.has(k));
    expect(orphans).toEqual([]);
  });
});

// ── leg impact tiers (ex-leg-impact.test.js) ───────────────────────────────────────────────────
// Seam test for the derived ladder-leg impact tiers (public/leg-impact.js). Plain `.js` so vitest
// collects it and tsc skips it; the registry import uses the `.ts` specifier (frontend.md).
describe("legImpactTiers", () => {
  it("returns null for a member the danger engine has no weight row for", () => {
    expect(legImpactTiers(undefined)).toBeNull();
    // A row that reaches no leg (every weight 0) is the same "nothing to say" case.
    expect(legImpactTiers({ Semis: 0, Staples: 0 })).toBeNull();
  });

  it("tops the tier list with the row's argmax legs and drops zero-weight legs", () => {
    // Expectation DERIVED from the live engine row, not hand-typed: a retune of MEMBER_WEIGHT.R4
    // moves both sides together, while a broken tiering still fails.
    const row = MEMBER_WEIGHT.R4;
    const max = Math.max(...Object.values(row));
    const argmax = Object.entries(row)
      .filter(([, w]) => w === max)
      .map(([sleeve]) => sleeve);
    const tiers = legImpactTiers(row);
    expect(tiers.top).toEqual(expect.arrayContaining(argmax));
    // Every named sleeve is a real ladder rung, and no zero-weight leg appears anywhere.
    const named = [...tiers.top, ...tiers.mid, ...tiers.low];
    for (const sleeve of named) expect(LADDER).toContain(sleeve);
    expect(named.every((s) => row[s] > 0)).toBe(true);
  });

  it("separates a clearly weaker leg from the strongest one", () => {
    // Discriminating fixture: 1.0 vs 0.2 must NOT land in the same tier (a flat/no-op tiering
    // would put both in `top`).
    const tiers = legImpactTiers({ Semis: 1.0, Value: 0.2 });
    expect(tiers.top).toEqual(["Semis"]);
    expect(tiers.low).toEqual(["Value"]);
  });
});

describe("legImpactClauses", () => {
  it("omits empty tiers and yields nothing for an absent row", () => {
    expect(legImpactClauses(null)).toEqual([]);
    expect(legImpactClauses({ Semis: 1.0, "S&P IT": 1.0 })).toEqual([
      { label: "hit hardest", sleeves: ["Semis", "S&P IT"] },
    ]);
  });
});
