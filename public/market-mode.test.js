import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MARKET_MODES,
  MARKET_MODE_GLYPHS,
  MARKET_MODE_IMPLIES,
  MARKET_MODE_TIPS,
  MODE_NA_GLYPH,
  marketMode,
  marketModeClass,
  marketModeCellHtml,
  marketModeFootHtml,
  marketModeQuadrantHtml,
} from "./market-mode.js";
import { BAND_CUTS } from "./sub-dangers.js";

// The served leg green→amber cut, IMPORTED from the FE mirror (`BAND_CUTS.amber`, itself pinned
// against the server `DANGER_CUTS` in sub-dangers.test.js) rather than re-typed — a re-typed literal
// would be a third source free to drift.
// Every fixture below is expressed RELATIVE to this value, so the suite tracks any future retune.
// Passed explicitly so the mode's danger boundary is the caller's served cut, not a literal.
const AMBER = BAND_CUTS.amber;

describe("marketMode - pure danger×growth quadrant label", () => {
  // Positive derivation: the mode is a pure function of served danger+growth only. Each pair
  // sits clearly inside one quadrant (well off the boundaries) with the served amber cut.
  it("derives all four cells from (danger, growth)", () => {
    expect(marketMode(0.05, 0.8, AMBER)).toBe("healthy markup"); // loDan, hiGro
    expect(marketMode(0.05, 0.2, AMBER)).toBe("calm accumulation"); // loDan, loGro
    expect(marketMode(0.5, 0.8, AMBER)).toBe("euphoric distribution"); // hiDan, hiGro
    expect(marketMode(0.5, 0.2, AMBER)).toBe("risk-off markdown"); // hiDan, loGro
  });

  // Boundary adjudication (settles the 0.5 growth split + the amber danger split by test):
  // both compares are `>=`, so a value exactly on a cut classifies HIGH.
  it("classifies a value exactly on a cut as HIGH (>=)", () => {
    // danger === amber → HIGH danger; the growth === 0.5 → HIGH edge rides the neutral-leg test below
    expect(marketMode(AMBER, 0.2, AMBER)).toBe("risk-off markdown");
  });

  it("puts an all-neutral leg (growth===0.5, danger just below amber) on healthy markup", () => {
    // The documented neutral split: a leg with all-neutral inputs folds to growth 0.5 and,
    // with danger below the amber cut, lands on the loDan/hiGro cell.
    expect(marketMode(AMBER - 0.001, 0.5, AMBER)).toBe("healthy markup");
  });

  it("returns null when growth is absent / non-finite (danger is always finite)", () => {
    expect(marketMode(0.4, null, AMBER)).toBeNull();
    expect(marketMode(0.4, undefined, AMBER)).toBeNull();
    expect(marketMode(0.4, NaN, AMBER)).toBeNull();
  });

  it("respects a caller-supplied non-default mid", () => {
    // With mid raised to 0.9, growth 0.8 now reads LOW.
    expect(marketMode(0.05, 0.8, AMBER, 0.9)).toBe("calm accumulation");
  });
});

describe("MARKET_MODES / tips - single label source", () => {
  it("has a tooltip for every label (keys align)", () => {
    for (const label of Object.values(MARKET_MODES)) {
      expect(MARKET_MODE_TIPS[label]).toBeTruthy();
    }
    expect(Object.keys(MARKET_MODE_TIPS).sort()).toEqual(Object.values(MARKET_MODES).sort());
  });
});

describe("marketModeClass - stable css token", () => {
  it("maps null → '' and every label → a DISTINCT non-empty token", () => {
    expect(marketModeClass(null)).toBe("");
    const tokens = Object.values(MARKET_MODES).map(marketModeClass);
    tokens.forEach((t) => expect(t).toBeTruthy());
    // All four classes distinct — a categorical channel needs four separable tints (Stage 3.3).
    expect(new Set(tokens).size).toBe(4);
  });
});

describe("marketModeCellHtml - /lab Mode column cell", () => {
  it("renders the na glyph for a null mode", () => {
    const html = marketModeCellHtml(null);
    expect(html).toContain(MODE_NA_GLYPH);
    expect(html).toContain("mode-na");
  });

  it("paints the mode's ARROW with its class, and hovers name · meaning · implication", () => {
    const html = marketModeCellHtml("euphoric distribution");
    expect(html).toContain(`>${MARKET_MODE_GLYPHS["euphoric distribution"]}</span>`);
    expect(html).toContain(marketModeClass("euphoric distribution"));
    const title = html.match(/title="([^"]*)"/)[1];
    // The label text left the CELL with IS-8(c), so the hover owes all three parts.
    expect(title).toContain("euphoric distribution");
    expect(title).toContain(MARKET_MODE_TIPS["euphoric distribution"]);
    expect(title).toContain(MARKET_MODE_IMPLIES["euphoric distribution"]);
  });
});

// ── Arrows in the cell, contract in the footnote.
describe("MARKET_MODE_GLYPHS - the RULED arrow set", () => {
  it("one distinct glyph per mode, keys aligned with MARKET_MODES", () => {
    expect(Object.keys(MARKET_MODE_GLYPHS).sort()).toEqual(Object.values(MARKET_MODES).sort());
    expect(new Set(Object.values(MARKET_MODE_GLYPHS)).size).toBe(4);
  });

  it("has an IMPLIES clause for every mode (the clause that separates the two up-arrows)", () => {
    expect(Object.keys(MARKET_MODE_IMPLIES).sort()).toEqual(Object.values(MARKET_MODES).sort());
    for (const m of Object.values(MARKET_MODES)) expect(MARKET_MODE_IMPLIES[m].length).toBeGreaterThan(20);
    // Non-vacuity of the SEPARATION the ruling bought: the accumulation/markup pair (and the
    // distribution/markdown pair) read alike as arrows, so their implications must NOT read alike.
    expect(MARKET_MODE_IMPLIES["calm accumulation"]).not.toBe(MARKET_MODE_IMPLIES["healthy markup"]);
    expect(MARKET_MODE_IMPLIES["euphoric distribution"]).not.toBe(MARKET_MODE_IMPLIES["risk-off markdown"]);
  });
});

describe("marketModeFootHtml - the MANDATORY footnote (a legend does not satisfy the rung)", () => {
  const foot = marketModeFootHtml();

  it("carries, per mode, its glyph AND name AND meaning AND implication", () => {
    for (const m of Object.values(MARKET_MODES)) {
      expect(foot, `footnote drops the ${m} glyph`).toContain(MARKET_MODE_GLYPHS[m]);
      expect(foot, `footnote drops the ${m} name`).toContain(m);
      expect(foot, `footnote drops what ${m} MEANS`).toContain(MARKET_MODE_TIPS[m]);
      expect(foot, `footnote drops what ${m} IMPLIES`).toContain(MARKET_MODE_IMPLIES[m]);
    }
  });

  it("carries the na row too - no arrow must not read as calm", () => {
    expect(foot).toContain("mode-na");
    expect(foot).toContain("never as calm");
  });
});

// ── The bleed guard the market-mode docblock warns about: the SAME `.mode-*`
// tokens land on the View-C `.rrg-leg` boxes and `.rrg-swatch` legend. Both channels now live in
// public/lab.css — the `#rrg-styles` sheet lab-board.js used to inject was refused outright by
// CSP `style-src 'self'`, so its rules moved into that file; the other door is public/styles.css.
describe("colour selectors are SCOPED (the .mode-* rules cannot bleed into the RRG stripe/swatch)", () => {
  const labCss = readFileSync("public/lab.css", "utf8");
  const labJs = readFileSync("public/lab-board.js", "utf8");
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ""); // a `.mode-accum` in prose is not a rule
  const scopedStyle = decomment(labCss);
  // Every selector in either sheet that mentions a mode token, one per comma-separated selector.
  const selectorsIn = (css, where) =>
    [...css.matchAll(/([^{}]*\.mode-[a-z-]+[^{}]*)\{/g)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim())
      .filter((s) => s.includes(".mode-"))
      .map((sel) => ({ sel, where }));
  const modeSelectors = selectorsIn(scopedStyle, "lab.css");
  // Both tint channels share one file now, so the two anchors below split it by HOST instead: the
  // ledger cell / footnote rules, and the View-C rules that used to be the injected sheet.
  const ledgerSelectors = modeSelectors.filter(({ sel }) => sel.includes(".df-"));
  const rrgSelectors = modeSelectors.filter(({ sel }) => sel.includes(".rrg-"));

  // The classes the seam really emits — derived, never hand-listed (a hand list omitted `mode-key`).
  // `marketModeQuadrantHtml()` is the LIVE /lab rendering; `marketModeFootHtml()` is
  // the kept reference rendering. Both are scanned, or a `.mode-*` token added to the live quadrant
  // alone would escape the anchoring guard below.
  const emitted = new Set(
    [
      marketModeFootHtml(),
      marketModeQuadrantHtml(),
      marketModeCellHtml(null),
      ...Object.values(MARKET_MODES).map(marketModeCellHtml),
    ]
      .flatMap((html) => [...html.matchAll(/class="([^"]*)"/g)])
      .flatMap((m) => m[1].split(/\s+/).filter(Boolean)),
  );
  const emittedModeClasses = [...emitted].filter((c) => c.startsWith("mode-"));

  it("finds the mode rules in BOTH channels (non-vacuity: the guard has something to police)", () => {
    expect(ledgerSelectors.length).toBeGreaterThanOrEqual(5);
    expect(rrgSelectors.length, "no View-C mode rule in lab.css - the moved sheet is gone").toBeGreaterThanOrEqual(4);
    // The derivation must cover the four tints, the glyph base, the na row AND the footnote key.
    expect(emittedModeClasses.length).toBeGreaterThanOrEqual(7);
    expect(emittedModeClasses).toContain("mode-key");
  });

  it("every mode selector is anchored to a host - the ledger cell, the footnote, or an RRG element", () => {
    const HOSTS = [".df-grid .col-mode", ".df-foot-modes", ".rrg-leg", ".rrg-swatch"];
    const unscoped = modeSelectors.filter(({ sel }) => !HOSTS.some((h) => sel.includes(h)));
    expect(
      unscoped,
      `bare .mode-* rule(s) would bleed across the ledger cell / footnote / RRG stripe: ${unscoped
        .map((u) => `${u.where}: ${u.sel}`)
        .join(" | ")}`,
    ).toEqual([]);
  });

  it("styles.css (also loaded by /lab) carries no mode-glyph rule at all - the other bleed door", () => {
    const shared = decomment(readFileSync("public/styles.css", "utf8"));
    for (const cls of emittedModeClasses) {
      expect(new RegExp(`\\.${cls}\\b`).test(shared), `styles.css styles .${cls} unscoped`).toBe(false);
    }
    // Non-vacuity: the same probe DOES find a class styles.css really declares.
    expect(/\.card-marker\b/.test(shared)).toBe(true);
  });

  it("the /lab Mode header legend is DERIVED from the glyph seam, not re-typed arrows", () => {
    const th = labJs.slice(labJs.indexOf('`<th class="col-mode"'), labJs.indexOf('`<th class="col-exo"'));
    expect(th.length, "the col-mode header moved - this pin is reading nothing").toBeGreaterThan(100);
    expect(th, "the Mode header stopped deriving its legend from MARKET_MODE_GLYPHS").toContain("MODE_ARROW_LEGEND");
    // MODE_NA_GLYPH is a plain "-" since the 2026-08-20 dash sweep, so it no longer
    // discriminates inside prose - only the arrow glyphs are pinned here.
    for (const g of Object.values(MARKET_MODE_GLYPHS)) {
      expect(th, `the Mode header re-types the "${g}" glyph - retuning it would leave the tooltip lying`).not.toContain(
        g,
      );
    }
  });
});

// ── Stage 3.4 — the display-only invariant (ADR §3.3: "a label that does not touch the
// selection rule cannot overfit it"). Both guards read REAL source and CAN fail: the label
// phrases + the `market-mode` seam name are unique enough that any leak into the engine lights
// them. vitest cwd = repo root, so these paths resolve relative to it.
function tsFilesUnder(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...tsFilesUnder(p));
    else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Comment-tolerant: drop whole-line comments (`//…`, `*…`, `/*…`) so the guard polices CODE, not
// a future docblock that legitimately names the FE seam it deliberately excludes. Imports and a
// leaked string literal are always code, so this never weakens the guard's ability to fail.
function codeOnly(src) {
  return src
    .split("\n")
    .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
    .join("\n");
}

describe("Stage 3.4 - display-only invariant (mode never reaches the danger engine)", () => {
  it("no MARKET_MODES label nor the 'market-mode' token appears in danger-engine.ts code", () => {
    const src = codeOnly(readFileSync("src/danger-engine.ts", "utf8"));
    for (const label of Object.values(MARKET_MODES)) {
      expect(src, `engine leaks mode label "${label}"`).not.toContain(label);
    }
    expect(src, "engine references the market-mode seam").not.toContain("market-mode");
  });

  it("no file under src/ or api/ imports the FE-only market-mode seam", () => {
    const files = [...tsFilesUnder("src"), ...tsFilesUnder("api")];
    // Guard against a vacuous scan: the walk must actually find engine source.
    expect(files.length).toBeGreaterThan(20);
    const leaks = files.filter((f) => codeOnly(readFileSync(f, "utf8")).includes("market-mode"));
    expect(leaks, `market-mode imported server-side by: ${leaks.join(", ")}`).toEqual([]);
  });
});
