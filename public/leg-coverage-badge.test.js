/*
 * The per-pillar coverage fact, a TOOLTIP CLAUSE — the visible `live/capable` badge and its `.lg-cov` /
 * `.lg-cov.partial` markup are gone.
 *
 * `public/lab.js` is a DOM-side-effecting browser module (top-level `document` wiring), so it cannot
 * be imported under vitest. `coverageClause` is a PURE helper of its two args, so we lift its source
 * out of lab.js and reconstruct it with `new Function` — this exercises the SHIPPED code, not a
 * hand-typed mirror of it (which the testing rules warn drifts silently).
 *
 * Two layers:
 *  1. Behaviour — the clause is EMPTY at full coverage / single-family super-group / absent payload,
 *     and states the shortfall in words at partial and dead coverage; it never contains `undefined`.
 *  2. Name-freedom — no leg/family/pillar proper name, so no name-sync duty, same construction as
 *     `CLAMP_CLAUSE`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// Lift the pure `coverageClause` helper out of lab.js and reconstruct it (it closes over nothing).
const labSrc = readFileSync(here("./lab-board.js"), "utf8");
const clauseSrc = labSrc.match(/function coverageClause\(coverage, superGroup\)\s*\{[\s\S]*?\n\}/);
if (!clauseSrc) throw new Error("coverageClause not found in lab-board.js - the R1 seam moved");
const coverageClause = new Function(`return (${clauseSrc[0]});`)();

const EW = "EARLY-WARN";

describe("coverageClause - R1: the coverage fact speaks only when it is a shortfall", () => {
  it("FULL coverage says nothing at all - the normal state prints no text anywhere", () => {
    expect(coverageClause({ [EW]: { live: 2, capable: 2 } }, EW)).toBe("");
    expect(coverageClause({ [EW]: { live: 3, capable: 3 } }, EW)).toBe("");
  });

  it("PARTIAL coverage states the shortfall in words, with both counts", () => {
    const clause = coverageClause({ [EW]: { live: 1, capable: 2 } }, EW);
    expect(clause).toContain("PARTIAL COVERAGE");
    expect(clause).toContain("1 of the 2");
    // It is a tooltip SUFFIX appended to an existing band title, so it must open as a clause, not as
    // a sentence — otherwise it runs into the band copy it follows.
    expect(clause.startsWith(" - ")).toBe(true);
  });

  it("a fully DEAD pillar (0 live) reads as no coverage, not as `0 of 2` partial coverage", () => {
    const clause = coverageClause({ [EW]: { live: 0, capable: 2 } }, EW);
    expect(clause).toContain("NO LIVE COVERAGE");
    expect(clause).not.toContain("PARTIAL COVERAGE");
    expect(clause).toContain("none of the 2");
  });

  it("single-family super-group (capable < 2) ⇒ no clause", () => {
    expect(coverageClause({ CONFIRMING: { live: 1, capable: 1 } }, "CONFIRMING")).toBe("");
    expect(coverageClause({ EXOGENOUS: { live: 0, capable: 1 } }, "EXOGENOUS")).toBe("");
  });

  it("absent coverage / missing super-group ⇒ no clause (never the literal `undefined`)", () => {
    for (const arm of [undefined, {}, { "STRESS-NOW": { live: 2, capable: 2 } }]) {
      expect(coverageClause(arm, EW)).toBe("");
    }
    // …and no reachable arm can leak `undefined` into the copy either.
    for (const c of [
      { live: 0, capable: 2 },
      { live: 1, capable: 2 },
      { live: 2, capable: 2 },
    ]) {
      expect(coverageClause({ [EW]: c }, EW)).not.toContain("undefined");
    }
  });

  it("applies to BOTH pillars - the rung binds EW and SN alike", () => {
    const sn = coverageClause({ "STRESS-NOW": { live: 1, capable: 2 } }, "STRESS-NOW");
    expect(sn).toContain("PARTIAL COVERAGE");
  });

  it("the clause is name-free (name-sync discharged by construction, as for CLAMP_CLAUSE)", () => {
    const NAMES = ["Semis", "S&P IT", "EM", "Value", "S&P 500", "ex-US", "EU-Fin", "Health",
      "Staples", "EARLY-WARN", "STRESS-NOW", "credit", "rates", "valuation", "volatility"];
    for (const c of [{ live: 0, capable: 2 }, { live: 1, capable: 2 }]) {
      const clause = coverageClause({ [EW]: c }, EW);
      for (const name of NAMES) expect(clause).not.toContain(name);
    }
  });
});
