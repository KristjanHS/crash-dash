/**
 * OQ-5 Stage 5.4 — the FE observation-census seam (`cell-observed.js`).
 *
 * The parity case below imports the REAL server builder (`buildMemberState`, src/danger-member-state.ts)
 * rather than re-typing its rule: a hand-copied mirror guards only one direction, and the mirror
 * drifting out of sync with the server IS the defect this stage fixes (the FE imputed `calm` for
 * an unobserved member from the absence-field change until now). Extensionless specifier on purpose — a plain
 * `.js` test file resolves specifiers literally (`.claude/rules/frontend.md`).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildMemberState } from "../src/danger-member-state";
import {
  absentMark,
  censusOf,
  foldOf,
  heldMark,
  heldOf,
  legCellLagMark,
  legLagMark,
  unmeasuredLagMark,
  memberSeverity,
  observedNote,
  lagMark,
} from "./cell-observed.js";
import { resolveField } from "./lab-board.js";

/** `lab.css` with every CSS comment stripped: a comment naming a selector is not a rule. */
const labStyleSansComments = () =>
  readFileSync(new URL("./lab.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("memberSeverity - the FE mirror of the server's severityOf", () => {
  it("maps observed states, and returns null (ABSENT) for an unobserved one", () => {
    expect(memberSeverity("RED")).toBe("lit");
    expect(memberSeverity("AMBER")).toBe("elev");
    expect(memberSeverity("GREEN")).toBe("calm");
    expect(memberSeverity(null)).toBe(null);
    expect(memberSeverity(undefined)).toBe(null);
  });

  it("agrees with the server's buildMemberState on which members are ABSENT", () => {
    const d = {
      globalFamilies: [
        {
          key: "credit",
          members: [
            { id: "F1", state: "RED" },
            { id: "F2", state: "GREEN" },
            { id: "EBP", state: null },
            { id: "F3", state: undefined },
          ],
        },
      ],
    };
    const server = buildMemberState(d);
    // The server keys ONLY the observed members; the two unobserved ones have no key at all.
    expect(Object.keys(server).sort()).toEqual(["F1", "F2"]);
    // Presence agrees…
    for (const m of d.globalFamilies[0].members) expect(memberSeverity(m.state) === null).toBe(server[m.id] === undefined);
    // …and so does the severity where present.
    const present = d.globalFamilies[0].members.filter((m) => memberSeverity(m.state) !== null);
    expect(present.length).toBeGreaterThan(0);
    for (const m of present) expect(memberSeverity(m.state)).toBe(server[m.id].sev);
  });
});

describe("censusOf / observedNote - the per-cell freshness counter", () => {
  it("reads the served census", () => {
    expect(
      censusOf({ observed: { fresh: 2, lag: 1, absent: 3, deepLag: 1, absentIds: ["AT1"] } }),
    ).toEqual({
      fresh: 2,
      lag: 1,
      absent: 3,
      deepLag: 1,
      absentIds: ["AT1"],
    });
    // A pre-I9.6 cached cell has no `deepLag` key: it reads 0, never inheriting `lag`.
    expect(censusOf({ observed: { fresh: 1, lag: 3, absent: 2 } })).toEqual({
      fresh: 1,
      lag: 3,
      absent: 2,
      deepLag: 0,
      absentIds: [],
    });
  });

  it("degrades a missing/garbage census to all-zero rather than fabricating one", () => {
    expect(censusOf({})).toEqual({ fresh: 0, lag: 0, absent: 0, deepLag: 0, absentIds: [] });
    expect(censusOf(undefined)).toEqual({ fresh: 0, lag: 0, absent: 0, deepLag: 0, absentIds: [] });
    expect(censusOf({ observed: { fresh: "2", lag: -1, absent: NaN, deepLag: -3, absentIds: "AT1" } })).toEqual({
      fresh: 0,
      lag: 0,
      absent: 0,
      deepLag: 0,
      // a non-array `absentIds` (or non-string entries) degrades to [] — no invented names
      absentIds: [],
    });
    // …and a mixed array keeps only the string entries (pins the element-level filter, not just
    // the whole-value non-array arm)
    expect(
      censusOf({ observed: { fresh: 1, lag: 0, absent: 2, absentIds: ["AT1", 3, null] } }).absentIds,
    ).toEqual(["AT1"]);
  });

  it("prints the counter, and prints NOTHING when the cell quantifies over no members", () => {
    expect(observedNote({ observed: { fresh: 2, lag: 1, absent: 3 } })).toBe(
      "obs 2 fresh · 1 lag · 3 absent",
    );
    expect(observedNote({ observed: { fresh: 0, lag: 0, absent: 0 } })).toBe("");
  });

});

describe("absentMark - a cell with any absent relevant member is visibly marked", () => {
  it("marks the cell with its absent COUNT and the sig-absent class", () => {
    expect(absentMark({ observed: { fresh: 1, lag: 0, absent: 2 } })).toEqual({
      cls: "sig-absent",
      html: '<sup class="sig-abs-n">2</sup>',
      count: 2,
    });
  });

  it("marks NOTHING when every member reported (the happy path is unchanged)", () => {
    expect(absentMark({ observed: { fresh: 3, lag: 1, absent: 0 } })).toBe(null);
  });
});

describe("lagMark - the per-cell feed-lag MODIFIER (§I9.8 J1)", () => {
  it("marks a late cell at the QUIET tier and a rotted one at the HEAVIER tier, without touching the severity glyph", () => {
    const late = lagMark({ observed: { fresh: 1, lag: 2, absent: 0, deepLag: 0 } });
    expect(late.cls).toBe("sig-lag-soft");
    const rotted = lagMark({ observed: { fresh: 1, lag: 2, absent: 0, deepLag: 1 } });
    expect(rotted.cls).toBe("sig-lag-deep");
    // A MODIFIER: the mark is a superscript the caller appends, never a `glyph` replacing the
    // cell's severity glyph (§I9.8 J1 rejects the swap — it would erase the severity map).
    expect(rotted.glyph).toBeUndefined();
    expect(rotted.html).toContain("◌");
    expect(rotted.html).toMatch(/^<sup /);
  });

  it("does NOT fire on an absent-only cell, nor on an all-zero (na / structural) census", () => {
    // Absence is not lag. `absentMark`'s `<sup>`
    // already counts members that never reported; firing here too put absence in a column headed `Lag` whose
    // legend asserts feed lateness, and double-showed it. A cell with lag AND absent still fires —
    // on the lag, which is the claim the column makes.
    expect(lagMark({ observed: { fresh: 0, lag: 0, absent: 1, deepLag: 0 } })).toBe(null);
    expect(lagMark({ observed: { fresh: 0, lag: 1, absent: 2, deepLag: 0 } }).cls).toBe("sig-lag-soft");
    expect(lagMark({ observed: { fresh: 3, lag: 0, absent: 0, deepLag: 0 } })).toBe(null);
    expect(lagMark({ observed: { fresh: 0, lag: 0, absent: 0, deepLag: 0 } })).toBe(null);
    expect(lagMark({})).toBe(null);
  });

  // The `?s=lag:<id>` knob (src/lab-assembly.ts `applyLagKnob`) must never reach the DARK tier. That pin
  // used to live here and was VACUOUS: it hand-typed the census it claimed the knob produces, so it
  // could not fail if the knob started emitting `DEEP-LAG`. It now lives where the knob does — the
  // `?s=lag:` case in `api/lab.test.ts` runs the REAL handler, feeds the label the knob actually
  // emitted through `lagTier`, and pins the served `deepLag` total unmoved. The FE half of the claim
  // (a deep-lag-free lag census paints at the quiet tier) is the `sig-lag-soft` case above.
});

describe("legLagMark - the per-leg roll-up of the same instrument (§I9.8 J2)", () => {
  const fresh = { observed: { fresh: 2, lag: 0, absent: 0, deepLag: 0 } };
  const late = { observed: { fresh: 1, lag: 1, absent: 0, deepLag: 0 } };
  const rotted = { observed: { fresh: 1, lag: 1, absent: 0, deepLag: 1 } };

  it("is off when no cell of the leg fires", () => {
    expect(legLagMark([fresh, fresh])).toBe(null);
    expect(legLagMark([])).toBe(null);
    expect(legLagMark(undefined)).toBe(null);
  });

  it("is DIM when only late cells fire", () => {
    const mark = legLagMark([fresh, late, late]);
    expect(mark.cls).toBe("sig-lag-soft");
    expect(mark.html).toContain("⌁");
    expect(mark.html).toContain("leg-lag");
  });

  it("takes the HEAVIER tier as soon as ONE rotted cell is present, wherever it sits", () => {
    expect(legLagMark([fresh, late, rotted]).cls).toBe("sig-lag-deep");
    expect(legLagMark([rotted, late, fresh]).cls).toBe("sig-lag-deep");
    expect(legLagMark([fresh, late, rotted]).html).toContain("sig-lag-deep");
  });
});

describe("legCellLagMark - the `◌` roll-up for the rightmost Lag column (IS-8(b))", () => {
  const fam = (family, o) => ({ family, observed: o });
  const fresh = fam("cr", { fresh: 2, lag: 0, absent: 0, deepLag: 0 });
  const late = fam("vl", { fresh: 1, lag: 1, absent: 0, deepLag: 0 });
  const rotted = fam("rt", { fresh: 1, lag: 1, absent: 0, deepLag: 1 });

  it("is off when no cell fires", () => {
    expect(legCellLagMark([fresh, fresh])).toBe(null);
    expect(legCellLagMark([])).toBe(null);
    expect(legCellLagMark(undefined)).toBe(null);
  });

  it("counts the FIRING cells only, not the leg's cells", () => {
    // 4 cells, 2 firing — the two numbers differ, so a count taken off the wrong list reds.
    const mark = legCellLagMark([fresh, late, fresh, rotted]);
    expect(mark.count).toBe(2);
    expect(mark.html).toContain("◌");
    expect(mark.html).toContain(">2</sup>");
  });

  it("takes the WORST tier, wherever the rotted cell sits", () => {
    expect(legCellLagMark([fresh, late, late]).cls).toBe("sig-lag-soft");
    expect(legCellLagMark([fresh, late, rotted]).cls).toBe("sig-lag-deep");
    expect(legCellLagMark([rotted, late, fresh]).cls).toBe("sig-lag-deep");
  });

  it("names the firing families and their tier in the title - and only those", () => {
    const title = legCellLagMark([fresh, late, rotted]).html.match(/title="([^"]+)"/)[1];
    const which = title.split("- ")[1]; // the family list, past the prose clause
    expect(which).toBe("vl lag · rt deep lag"); // the fresh `cr` cell is not a diagnostic
  });
});

/**
 * IS-8(b) placement pin. The ruling is that BOTH marks sit in the RIGHTMOST ledger column and that
 * "header, rows and `NCOLS` move together" — a half-move silently misaligns the `df-attrib`
 * colspan. `lab.js` executes DOM side effects at import and can never be imported here
 * (`.claude/rules/frontend.md`), and a markup test proves emission, never PLACEMENT, so the pin
 * reads the shipped source: it cross-checks the fixed `<th>` count on each side of the signal
 * columns AND the fixed `<td>` count in the body row against the two numbers in the `NCOLS`
 * expression. All three counts are taken on the tag (`<th` / `<td`), never on a `col-` class
 * prefix — the head already carries a deliberately non-`col-` header (`sig-h`), so a class-keyed
 * counter would let a new header in that house style slip in with NCOLS unchanged.
 */
describe("the danger ledger's Lag column (lab-board.js source)", () => {
  const src = readFileSync(new URL("./lab-board.js", import.meta.url), "utf8");
  // Whole-line comments dropped so the counters police EMITTED markup, not a docblock that
  // legitimately quotes a `<th>`/`<td>`; every real cell is code, so this cannot weaken them.
  const codeOnly = (s) =>
    s
      .split("\n")
      .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
      .join("\n");
  const head = codeOnly(src.slice(src.indexOf("const head ="), src.indexOf("const NCOLS")));
  // The signal block is variable-width (`sigCols.length`), so it is EXCISED rather than counted:
  // everything before `sigCols.map` is the leading fixed run, everything from its `.join(` is the
  // trailing one.
  const split = head.indexOf("sigCols.map");
  const headBefore = head.slice(0, split);
  const headAfter = head.slice(head.indexOf(".join(", split));
  const row = codeOnly(src.slice(src.indexOf("const row ="), src.indexOf("const attribRow")));
  const m = src.match(/const NCOLS = (\d+) \+ sigCols\.length \+ (\d+);/);
  const count = (s, tag) => (s.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;

  it("NCOLS agrees with the fixed HEADER cells actually emitted around the signal columns", () => {
    expect(m, "the NCOLS expression changed shape - this whole pin is reading nothing").toBeTruthy();
    // Non-vacuity: both runs must really be there (a 0-vs-0 match would pass while pinning nothing).
    expect(count(headBefore, "th")).toBeGreaterThan(0);
    expect(count(headAfter, "th")).toBeGreaterThan(0);
    expect(count(headBefore, "th")).toBe(Number(m[1]));
    expect(count(headAfter, "th")).toBe(Number(m[2]));
  });

  it("the BODY ROW emits exactly NCOLS fixed cells - the half of the move a header-only pin misses", () => {
    // The ruling is "header, ROWS and NCOLS move together": adding a `<td>` without a `<th>` (or
    // dropping one) leaves every `df-attrib` colspan short and shifts the whole signal block under
    // the wrong headers. `sigCells` is interpolated, not literal, so the row's own `<td`s are
    // exactly the fixed columns.
    expect(count(row, "td")).toBeGreaterThan(0);
    expect(count(row, "td")).toBe(Number(m[1]) + Number(m[2]));
  });

  it("Lag is the last header cell and the last row cell", () => {
    expect(headAfter.lastIndexOf('col-lag"')).toBeGreaterThan(headAfter.lastIndexOf('col-risk"'));
    expect(row.lastIndexOf('col-lag"')).toBeGreaterThan(row.lastIndexOf('col-risk"'));
  });

  it("neither mark is left behind in an operational column", () => {
    const row = src.slice(src.indexOf("const row ="), src.indexOf("const attribRow"));
    const danger = row.slice(row.indexOf('`<td class="col-danger"'), row.indexOf('`<td class="col-ew"'));
    expect(danger).not.toContain("lagMark");
    // the per-cell `◌` left `decorateCell` with `lagMark`; only `absentMark` still rides a cell
    const decorate = src.slice(src.indexOf("function decorateCell"), src.indexOf("function resolveField"));
    expect(decorate).toContain("absentMark(cell)");
    expect(decorate).not.toContain("lagMark(cell)");
  });
});

describe("heldOf / heldMark / observedNote - B2 hold-window provenance", () => {
  // ⚠ Every `closes`/`ageCloses` literal below is a made-up SERVED number, NOT a real hold window — the
  // FE holds no copy of those (they live server-side), and a fixture quoting one would be the first copy.
  it("reads the served mark and degrades anything malformed to null, never a fabricated one", () => {
    expect(heldOf({ held: { member: "R4", closes: 7, ageCloses: 2 } })).toEqual({
      member: "R4",
      closes: 7,
      ageCloses: 2,
    });
    // A pre-B2 cached response has no key at all; `null` is the server's own "not held".
    expect(heldOf({})).toBe(null);
    expect(heldOf(undefined)).toBe(null);
    expect(heldOf({ held: null })).toBe(null);
    // Malformed halves: a non-string member, and a window that is not a positive finite count. The
    // FE cannot invent either (the windows live at `signalHoldClosesFor`, server-side), so it declines.
    expect(heldOf({ held: { member: 4, closes: 7 } })).toBe(null);
    expect(heldOf({ held: { member: "", closes: 7 } })).toBe(null);
    expect(heldOf({ held: { member: "R4", closes: 0 } })).toBe(null);
    expect(heldOf({ held: { member: "R4", closes: "7" } })).toBe(null);
    expect(heldOf({ held: { member: "R4", closes: NaN } })).toBe(null);
  });

  // The AGE degrades ASYMMETRICALLY — a served payload without it (or malformed) is `ageCloses: null`
  // = UNKNOWN, never 0, never `closes`, never any other number.
  it("degrades a missing or malformed age to null - the mark survives, the age is not invented", () => {
    for (const held of [
      { member: "R4", closes: 7 }, // pre-Stage-2 payload: the mark exists, the age does not
      { member: "R4", closes: 7, ageCloses: null },
      { member: "R4", closes: 7, ageCloses: "2" },
      { member: "R4", closes: 7, ageCloses: NaN },
      { member: "R4", closes: 7, ageCloses: -1 },
    ]) {
      const h = heldOf({ held });
      // The mark itself is intact — a bad age must not suppress the member the cell rests on.
      expect(h, JSON.stringify(held)).toEqual({ member: "R4", closes: 7, ageCloses: null });
    }
    // …and the one number the FE may report is the one the server sent, floored, including `0` — the
    // newest STORED close, which is a real served answer and must not be confused with "unknown".
    expect(heldOf({ held: { member: "R4", closes: 7, ageCloses: 0 } }).ageCloses).toBe(0);
    expect(heldOf({ held: { member: "R4", closes: 7, ageCloses: 2.7 } }).ageCloses).toBe(2);
  });

  it("emits sig-held only when the server named a held member", () => {
    expect(heldMark({ held: { member: "BUND", closes: 11 } }).cls).toBe("sig-held");
    expect(heldMark({ held: { member: "BUND", closes: 11 } }).member).toBe("BUND");
    // The ordinary cell renders byte-identically to pre-B2 — no class, no glyph.
    expect(heldMark({ observed: { fresh: 3, lag: 0, absent: 0 } })).toBe(null);
  });

  /* REGRESSION (2026-08-20): the overline must not be a COLLAPSED BORDER. `.df-grid` is
     `border-collapse: collapse`, so a `border-top` on a body cell in the TOPMOST row loses the
     collapse tie-break to `.df-grid thead th`'s `border-bottom: 1px solid var(--line)` (CSS 2.1
     §17.6.2.1 — same width, same style, both cells, the upper one wins). The top row then painted
     NO hold mark while the footnote still named its held member. A painted inset shadow is not
     collapsed, so it survives on row 1. Red-demo: put `border-top` back in the rule body. */
  it("paints the hold mark with an inset shadow, never a collapsed border-top", () => {
    const rule = labStyleSansComments().match(/\.df-grid \.sig\.sig-held\s*\{([^}]*)\}/);
    expect(rule, ".df-grid .sig.sig-held rule not found in lab.css").not.toBe(null);
    expect(rule[1]).toContain("box-shadow: inset 0 1px 0 var(--elev)");
    expect(rule[1]).not.toContain("border-top");
  });

  // COPY: served facts only — the member, the AGE of the severity shown, and the window it cannot
  // outlive; no WHY, no other member. The clause is OMITTED when nothing is held, so its presence is
  // always a measurement — this assertion reds if the clause is emitted unconditionally.
  it("appends the held clause beside the census, and omits it entirely when nothing is held", () => {
    const census = { fresh: 2, lag: 0, absent: 0 };
    expect(observedNote({ observed: census, held: { member: "R4", closes: 7, ageCloses: 2 } })).toBe(
      "obs 2 fresh · 0 lag · 0 absent · held R4 - severity from the hold window, printed 2 closes back, " +
        "window ≤7; the hold ends when R4 prints green",
    );
    // SINGULAR — a one-close age reads "1 close back", not "1 closes back".
    expect(observedNote({ observed: census, held: { member: "R4", closes: 7, ageCloses: 1 } })).toContain(
      "printed 1 close back",
    );
    // THE DEGRADE, on the surface the user actually reads: a pre-Stage-2 payload says the age is
    // UNKNOWN. No number appears — not `0`, and not the window's `7` standing in for the age.
    const unknown = observedNote({ observed: census, held: { member: "R4", closes: 7 } });
    expect(unknown).toBe(
      "obs 2 fresh · 0 lag · 0 absent · held R4 - severity from the hold window, age unknown, " +
        "window ≤7; the hold ends when R4 prints green",
    );
    expect(unknown).not.toContain("closes back");
    expect(observedNote({ observed: census })).toBe("obs 2 fresh · 0 lag · 0 absent");
    // An all-zero census is still not a measurement — the held mark does not resurrect the clause.
    expect(
      observedNote({ observed: { fresh: 0, lag: 0, absent: 0 }, held: { member: "R4", closes: 7, ageCloses: 2 } }),
    ).toBe("");
  });
});

describe("foldOf - the directional-fold stand-down mark (mid raw≠confirmed)", () => {
  // ⚠ `of` is a made-up SERVED number (the server's `confirmClosesFor`), NOT an FE literal - a fixture
  // quoting one would be the first copy. Mirrors heldOf's asymmetric degrade exactly.
  it("normalises a well-formed mark and floors `of`", () => {
    expect(foldOf({ fold: { raw: "GREEN", of: 2 } })).toEqual({ raw: "GREEN", of: 2 });
    expect(foldOf({ fold: { raw: "AMBER", of: 2.7 } })).toEqual({ raw: "AMBER", of: 2 });
  });

  it("degrades a missing or malformed mark to null, never a fabricated one", () => {
    // No key / null: the member is not mid-stand-down.
    expect(foldOf({})).toBe(null);
    expect(foldOf(undefined)).toBe(null);
    expect(foldOf({ fold: null })).toBe(null);
    // Malformed halves - a non-string raw, and an `of` that is not a positive finite count.
    expect(foldOf({ fold: { raw: 4, of: 2 } })).toBe(null);
    expect(foldOf({ fold: { raw: "", of: 2 } })).toBe(null);
    expect(foldOf({ fold: { raw: "GREEN", of: 0 } })).toBe(null);
    expect(foldOf({ fold: { raw: "GREEN", of: "2" } })).toBe(null);
    expect(foldOf({ fold: { raw: "GREEN", of: NaN } })).toBe(null);
  });
});

/**
 * unmeasuredLagMark: with no freshness stamp the `Lag` column must render the absence AS an absence —
 * never a fabricated count (a `[]` feedLag once read `⌁◌⁶`), never a silent empty cell. These pin both.
 */
describe("unmeasuredLagMark - no freshness stamp is not a lag claim (A4)", () => {
  it("renders `-` on its own neutral tier, never a lag tier or a count, and says NOT MEASURED both ways", () => {
    const m = unmeasuredLagMark();
    expect(m.cls).toBe("sig-lag-unmeasured");
    // The false claim was the SUPERSCRIPT COUNT; the whole mark is one span whose text is `-`.
    expect(m.html).toMatch(/^<span class="leg-lag sig-lag-unmeasured" title="[^"]+">-<\/span>$/);
    // Both directions of the substitute-a-value-for-an-absence defect are disclaimed in one string.
    expect(m.html).toContain("NOT MEASURED");
    expect(m.html).toContain("Not a claim that they are lagging");
    expect(m.html).toContain("not a claim that they are current");
  });

  it("VACUITY GUARD - the cells that produced the false `◌⁶` still fire the real mark when a stamp exists", () => {
    // The exact shape prod served with the stamp MISSING: every member of a populated cell `lag`.
    const unstamped = { family: "cr", observed: { fresh: 0, lag: 8, absent: 0, deepLag: 0 } };
    // Suppression is the CALLER's job (lab.js gates on `freshnessMissing`); the census itself is
    // indistinguishable from a genuine all-lagging cell, which is precisely why the flag is needed.
    expect(legCellLagMark([unstamped]).count).toBe(1);
    expect(legLagMark([unstamped]).cls).toBe("sig-lag-soft");
  });
});

/**
 * The `fold` overlap clause on the LIVE path — a REAL-INVOCATION join, not the pure `cell-tip.js` seam.
 * The seam test (`cell-tip.test.js`) injects a synthetic member with `.fold` straight in, so it stayed
 * green while the clause was dead on prod: `decorateCell`'s roster whitelist dropped `fold`, and the
 * danger field's member map has no `fold` (it lives only on `d.globalFamilies`). This drives
 * `resolveField` end-to-end so the clause reaches the rendered `tip` iff the join actually carries the
 * fold from the panel through the whitelist. Red-demo: drop `fold` from the whitelist → this reds.
 */
describe("resolveField - the fold overlap clause survives the real board join", () => {
  const DANGER_MODEL = {
    familyOfSignal: { cr: "credit" },
    memberRelevance: { R4: ["equity"] },
    memberLabel: { R4: "10y TIPS delta" },
    memberWeight: { R4: { equity: 0.8 } },
  };
  // A fixture `d` whose credit family's live member `R4` carries a directional-fold mark, and whose
  // danger field makes R4 the cell's argmax `held.member`. `withFold` toggles ONLY the panel mark —
  // the discriminator that proves the clause tracks the joined fold, not an always-on string.
  const fixture = (withFold) => ({
    freshnessMissing: false,
    globalFamilies: [
      {
        key: "credit",
        members: [{ id: "R4", state: "GREEN", ...(withFold ? { fold: { raw: "RED", of: 2 } } : {}) }],
        absentIds: [],
      },
    ],
    field: {
      band: null,
      held: null,
      memberState: { R4: { sev: "elev", held: true, heldAge: 1 } },
      legRows: [
        {
          sleeve: "equity",
          cells: [
            {
              family: "cr",
              cellState: "elev",
              M: 1,
              N: 1,
              observed: { fresh: 1, lag: 0, absent: 0, absentIds: [] },
              held: { member: "R4", closes: 7, ageCloses: 1 },
            },
          ],
        },
      ],
    },
  });

  it("carries the fold from d.globalFamilies through decorateCell to the rendered cell tip", () => {
    // PREMISE GUARD: the member ROW proves the roster join populated, so a missing clause below can
    // only be the whitelist/thread defect — never the degraded empty-roster path.
    const tip = resolveField(fixture(true), DANGER_MODEL).legRows[0].cells[0].tip;
    expect(tip, "roster join did not reach R4's member row").toContain("R4 10y TIPS delta");
    expect(tip).toContain("is itself held by the fold (raw RED)");
  });

  it("DISCRIMINATOR - no fold on the panel member ⇒ no clause (the same argmax hold, no overlap)", () => {
    const tip = resolveField(fixture(false), DANGER_MODEL).legRows[0].cells[0].tip;
    // The hold-window sentence still prints (R4 is still the argmax held member)…
    expect(tip).toContain("carried by the hold window");
    // …but the overlap clause is absent, so its presence above is a measurement of the joined fold.
    expect(tip).not.toContain("is itself held by the fold");
  });
});
