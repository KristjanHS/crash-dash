import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The mirror pin below reads the SERVER constant directly rather than re-typing it.
// A hand-copied literal is a THIRD source — it goes stale the moment a remap moves the cuts, which
// is exactly the drift this import kills.
// `public/*.test.js` importing a TS module uses an extensionless specifier, never `.js` (`frontend.md`).
import { DANGER_CUTS } from "../src/danger-engine";

import {
  BAND_CUTS,
  bandClass,
  setBandCuts,
  regimeChipLabel,
  pillarValue,
  pillarBar,
  pillarBarHtml,
  CLAMP_CLAUSE,
  CALM_SLIVER_PCT,
  BAR_FULL_SCALE,
  bandTicks,
  SN_ROC_CUTS,
  snSpeedArrow,
  ewSpeedArrow,
  exoGlyph,
  bulletModel,
} from "./sub-dangers.js";

// W6 Stage 6.5 — the served pillar is a TAGGED UNION (`PillarScore`, src/danger-engine.ts), so every
// fixture below constructs an ARM, never a bare number. Constructors, not literals, so a fourth arm
// is one edit here.
const scored = (value) => ({ kind: "scored", value });
const NOT_LIVE = { kind: "uncomparable", reason: "not-live" };

// `setBandCuts` mutates module-level `activeCuts`; without this reset a mid-test
// failure would leak served cuts into later default-arg asserts (module-state
// hygiene). Restores the shipped BAND_CUTS default after every test.
afterEach(() => setBandCuts(undefined));

describe("bandClass - FE band-colour seam", () => {
  it("default cuts mirror the server DANGER_CUTS", () => {
    // C-1 §4: the mirror moves in the SAME commit as the server constant — a lagging mirror reds here.
    expect(BAND_CUTS).toEqual({ amber: DANGER_CUTS.amber, red: DANGER_CUTS.red });
  });
  it("maps values across the amber/red edges", () => {
    expect(bandClass(0)).toBe("g");
    expect(bandClass(BAND_CUTS.amber - 0.001)).toBe("g");
    expect(bandClass(BAND_CUTS.amber)).toBe("a"); // >= amber
    expect(bandClass(BAND_CUTS.red - 0.001)).toBe("a");
    expect(bandClass(BAND_CUTS.red)).toBe("r"); // >= red
    expect(bandClass(1)).toBe("r");
  });
  it("colours from an explicit cuts arg (the served-cuts seam) without mutating state", () => {
    // The probe + served cuts are DERIVED from BAND_CUTS so the discrimination this test exists for
    // cannot silently collapse on a retune: the hand-typed `0.15 / served 0.2` pair worked only while
    // the default amber sat BELOW 0.2, and a remap (0.129 → 0.2412) put it above, which
    // would have turned "≥ default amber" into a plain green assertion asserting nothing about amber.
    // `probe` sits ABOVE the default amber but BELOW the served amber ⇒ the two cut sources MUST
    // disagree on it, which is precisely the seam under test.
    const probe = BAND_CUTS.amber + 0.01;
    const served = { amber: probe + 0.05, red: probe + 0.3 };
    expect(bandClass(served.amber, served)).toBe("a"); // ≥ served amber
    expect(bandClass(probe, served)).toBe("g"); // below served amber — served cuts win
    expect(bandClass(probe)).toBe("a"); // ≥ default amber — the default stays unaffected
    expect(bandClass(served.red, served)).toBe("r"); // ≥ served red
    // Non-vacuity: the probe must actually straddle the two ambers, else the middle pair is one band.
    expect(probe).toBeGreaterThanOrEqual(BAND_CUTS.amber);
    expect(probe).toBeLessThan(served.amber);
  });
});

describe("setBandCuts - adopts the server-sent leg-RAG cuts", () => {
  it("shifts the active cuts, then a bad payload restores the default", () => {
    // Same derived straddle as the bandClass seam test above (see its comment): `probe` is amber under
    // the DEFAULT cuts and green under the SERVED ones, so each assertion below names a real switch.
    const probe = BAND_CUTS.amber + 0.01;
    setBandCuts({ amber: probe + 0.05, red: probe + 0.3 });
    expect(bandClass(probe)).toBe("g"); // below the served amber
    setBandCuts(null); // malformed ⇒ back to BAND_CUTS default
    expect(bandClass(probe)).toBe("a"); // ≥ default amber restored
    setBandCuts(undefined); // keep the default active for the rest of the suite
  });
});

describe("regimeChipLabel - D1.1 chip label mapping", () => {
  it("maps each server regime to its display label", () => {
    expect(regimeChipLabel("calm")).toBe("CALM");
    expect(regimeChipLabel("deter")).toBe("DETER");
    expect(regimeChipLabel("stress")).toBe("STRESS");
    expect(regimeChipLabel("recov")).toBe("RECOV");
  });
  it("returns '' for an unknown/absent regime so the caller omits the chip", () => {
    expect(regimeChipLabel(undefined)).toBe("");
    expect(regimeChipLabel("bogus")).toBe("");
  });
});

describe("pillarBar - D1.3 value→width/band mapping (+ calm sliver, verdict 4)", () => {
  it("clamps to 0-100% and colours by own band", () => {
    // One literal per BAND at today's cuts (amber 0.3362, red 0.5435); `pct` = round(v / BAR_FULL_SCALE · 100).
    expect(pillarBar(0.2)).toEqual({ pct: 20, band: "g" }); // < amber, and pct > CALM_SLIVER_PCT
    expect(pillarBar(0.4)).toEqual({ pct: 40, band: "a" }); // amber ≤ 0.4 < red
    expect(pillarBar(1.5)).toEqual({ pct: 100, band: "r" });
  });
  it("the axis tops out at share 1, and a red 0.6 pillar paints below full", () => {
    expect(pillarBar(1).pct).toBe(100);
    expect(pillarBar(0.6)).toEqual({ pct: 60, band: "r" });
  });
  it("calm rendering: a MEASURED low value floors at the green sliver, never an empty track", () => {
    expect(pillarBar(0)).toEqual({ pct: CALM_SLIVER_PCT, band: "g" });
    expect(pillarBar(0.01)).toEqual({ pct: CALM_SLIVER_PCT, band: "g" });
    expect(pillarBar(-1)).toEqual({ pct: CALM_SLIVER_PCT, band: "g" });
  });
  it("null pillar ⇒ width 0 / na band (absent - no fill, NOT a calm sliver)", () => {
    expect(pillarBar(null)).toEqual({ pct: 0, band: "na" });
  });
});

describe("bandTicks - verdict 8 band-cut tick positions from the ACTIVE cuts", () => {
  it("derives amber/red tick positions from the cuts (never hard-coded literals)", () => {
    // Ticks ride the fill's axis: `cut / BAR_FULL_SCALE · 100`, derived from the CUTS.
    expect(bandTicks()).toEqual([
      { pct: Math.min(100, (BAND_CUTS.amber / BAR_FULL_SCALE) * 100), band: "a" },
      { pct: Math.min(100, (BAND_CUTS.red / BAR_FULL_SCALE) * 100), band: "r" },
    ]);
    // …and out-of-band VALUE literals for today's cuts, so a joint edit of both sources is loud.
    expect(bandTicks()[0].pct).toBeCloseTo(33.62, 3); // amber 0.3362
    expect(bandTicks()[1].pct).toBeCloseTo(54.35, 3); // red 0.5435 — inside the axis, not clamped
    // An explicit (served) cuts arg is rescaled by the same constant, not by a second literal.
    expect(bandTicks({ amber: 0.27, red: 0.54 })).toEqual([
      { pct: 27, band: "a" },
      { pct: 54, band: "r" },
    ]);
  });
  it("a cut PAST BAR_FULL_SCALE pins the tick to the axis end instead of vanishing", () => {
    // `.lg-bar-track` is `overflow: hidden`, so an unclamped `left:129.6%` hairline is CLIPPED —
    // a decision-relevant band cut would disappear with nothing on screen saying so. 1.3 ⇒ 130 unclamped.
    const [amber, red] = bandTicks({ amber: 1, red: 1.3 });
    expect(red.pct).toBe(100);
    expect(red.pct).not.toBeCloseTo(130, 2); // non-vacuity: red under the PRE-clamp code
    expect(amber.pct).toBe(100); // exactly at the axis end is unaffected by the clamp
  });
});

describe("snSpeedArrow - verdict 5 SN 5-close ROC → speed arrow (7 states + missing)", () => {
  it("steps ↗/↑/⇈ (warm) and ↘/↓/⇊ (cool) at the cuts - SN and EW on the SAME SN_ROC_CUTS, only the copy differs (USER q1)", () => {
    for (const [roc, glyph, cls] of [
      [SN_ROC_CUTS[0], "↗", "w1"], // level 1 at the cut (≥)
      [0.05, "↑", "w2"],
      [0.3, "⇈", "w3"],
      [-0.02, "↘", "c1"],
      [-0.07, "↓", "c2"],
      [-1, "⇊", "c3"],
      [0.019, "→", "s0"],
    ]) {
      const sn = snSpeedArrow(roc);
      const ew = ewSpeedArrow(roc);
      expect([sn.glyph, sn.cls, ew.glyph, ew.cls], `roc ${roc}`).toEqual([glyph, cls, glyph, cls]);
      expect(ew.title, `roc ${roc}: the pillars never share a tooltip`).not.toBe(sn.title);
    }
  });
  it("flat (|snRoc| below the level-1 cut) ⇒ steady title", () => {
    expect(snSpeedArrow(0.019).title).toContain("steady");
  });
  it("missing snRoc (scenario / degraded / SN not live) ⇒ NO arrow at all", () => {
    expect(snSpeedArrow(undefined).glyph).toBe("");
    expect(snSpeedArrow(null).glyph).toBe("");
    expect(snSpeedArrow(NaN).glyph).toBe("");
  });
  it("titles are state-specific and carry the ×100 weekly delta (verdict 3)", () => {
    expect(snSpeedArrow(0.12).title).toContain("+12");
    expect(snSpeedArrow(0.12).title).toContain("spiking");
    expect(snSpeedArrow(-0.06).title).toContain("-6");
  });
});

describe("ewSpeedArrow - D2.3 per-pillar copy", () => {
  it("EW titles name EW's OWN 20-close lookback, not SN's 5 (the cadence hedge)", () => {
    expect(ewSpeedArrow(0.12).title).toContain("over the last 20 closes");
    expect(ewSpeedArrow(0.12).title).toContain("early-warn spiking");
    expect(ewSpeedArrow(0.12).title).toContain("+12");
    expect(snSpeedArrow(0.12).title).toContain("over the last 5 closes");
  });
});

describe("exoGlyph - verdict 6 EXOGENOUS weather glyph from G1's confirmed state", () => {
  it("maps calm/elev/lit → ▶ g / ▲ a / ▲▲ r with a state-specific impact title", () => {
    expect(exoGlyph("calm")).toMatchObject({ glyph: "▶", band: "g" });
    expect(exoGlyph("elev", 0.25)).toMatchObject({ glyph: "▲", band: "a" });
    expect(exoGlyph("lit", 0.5)).toMatchObject({ glyph: "▲▲", band: "r" });
    // The served number is the MINIMUM per-leg weighted oil danger, not a uniform floor, so the
    // title says "at least N", not "every leg floored at N".
    expect(exoGlyph("lit", 0.5).title).toContain("at least 0.5");
    expect(exoGlyph("lit", 0.5).title).not.toContain("every leg");
    expect(exoGlyph("elev", 0.25).title).toContain("at least 0.25");
    expect(exoGlyph("calm").title).toContain("WTI calm");
  });
  it("absent/unknown G1 state ⇒ the calm OUTCOME (an absent member can never manufacture danger)", () => {
    expect(exoGlyph(undefined).glyph).toBe("▶");
    expect(exoGlyph(undefined).band).toBe("g");
    expect(exoGlyph(null).glyph).toBe("▶");
  });
  // Same glyph, DIFFERENT copy — an absent feed is not a measurement of calm oil.
  it("says the feed did not report instead of asserting oil is calm", () => {
    expect(exoGlyph(undefined).title).toContain("not reporting");
    expect(exoGlyph(undefined).title).not.toContain("WTI calm");
    expect(exoGlyph("calm").title).toContain("WTI calm");
  });
  // NEGATIVE ARM — the glyph keys on G1/WTI alone, but the engine's `gp` term is a weighted max over
  // G1, OVX and BRENT (all ×1.0). A copy claiming the whole term is inert whenever WTI is calm/absent
  // is FALSE — OVX carries danger independently (and BRENT can SET a leg when it scores worse, since
  // the engine maxes `weight × severity`). This pin makes that false claim un-restorable. Omitting
  // `Brent` from the copy is an INCOMPLETENESS, not a choice — the served field carries no per-member
  // `gp` state to widen it with (see `sub-dangers.js`). Do NOT re-add a `not.toContain("Brent")`
  // negative: it would point the wrong way.
  it("never claims the exogenous FAMILY is quiet when only WTI is calm/absent", () => {
    for (const title of [exoGlyph("calm").title, exoGlyph(undefined).title]) {
      expect(title).toContain("OVX");
      expect(title).not.toMatch(/adds nothing|no exogenous danger claimed|no exogenous shock/);
    }
  });
});

describe("bulletModel - D1.4 SN bar + EW tick on a shared scale", () => {
  it("SN → bar pct/band, EW → tick pct/band, band ladder from BAND_CUTS", () => {
    const m = bulletModel({ earlyWarn: scored(0.4), stressNow: scored(0.8) });
    expect(m.snPct).toBe(80);
    expect(m.snBand).toBe("r"); // 0.8 ≥ red
    expect(m.tickPct).toBe(40);
    expect(m.tickBand).toBe("a"); // amber ≤ 0.4 < red
    expect(m.bands).toEqual([
      { cls: "g", to: BAND_CUTS.amber * 100 },
      { cls: "a", to: BAND_CUTS.red * 100 },
      { cls: "r", to: 100 },
    ]);
  });
  it("non-live EW ⇒ tick absent (null); non-live SN ⇒ bar width 0", () => {
    const m = bulletModel({ earlyWarn: NOT_LIVE, stressNow: NOT_LIVE });
    expect(m.tickPct).toBeNull();
    expect(m.snPct).toBe(0);
    expect(m.snBand).toBe("na");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// W6 Stage 6.5 — the `PillarScore` union at the FE: narrowing seam + bar markup.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("pillarValue - the ONE FE narrowing seam over PillarScore", () => {
  it("unwraps `scored` and yields null for `not-live`", () => {
    expect(pillarValue(scored(0.42))).toBe(0.42);
    expect(pillarValue(NOT_LIVE)).toBeNull();
  });
  it("tolerates a missing pillar (older cached payload / scenario row) as null, never NaN", () => {
    expect(pillarValue(undefined)).toBeNull();
    expect(pillarValue(null)).toBeNull();
  });
});

// The per-label band-copy table `lab.js` injects. Test-local ROUTING fixture, deliberately NOT a copy
// of lab.js's BAR_TITLE prose (which would be a silent-drift mirror): the assertions below pin that
// the seam CALLS the right band's builder and appends the clause, never the shipped wording. The
// lab.js→seam wiring itself is pinned by the source-level test at the bottom of this block.
const TITLES = {
  na: "NA-COPY",
  g: (n) => `G-COPY ${n}`,
  a: (n) => `A-COPY ${n}`,
  r: (n) => `R-COPY ${n}`,
};
const TICKS = '<span class="lg-bar-tick" data-css-left="12.9"></span>';
// The caller no longer injects trailing badge MARKUP — it injects tooltip CLAUSES.
// A test-local sentinel, deliberately not lab.js's shipped `coverageClause` wording (that would be a
// silent-drift mirror); the assertions pin that the seam appends whatever it is handed, on every branch.
const COV_CLAUSE = " - COV-CLAUSE";
const opts = { ticksHtml: TICKS, clauses: [COV_CLAUSE], titles: TITLES };

describe("pillarBarHtml - scored fill / na empty track", () => {
  it("(b) a `not-live` pillar still emits the EMPTY framed track (ticks, no fill) + the na copy", () => {
    const html = pillarBarHtml("E", NOT_LIVE, opts);
    expect(html).toContain('<span class="lg-bar-track">' + TICKS + "</span>");
    expect(html).not.toContain("lg-bar-fill");
    expect(html).toContain(`title="NA-COPY${COV_CLAUSE}"`);
  });
  it("R1 - every branch keeps the label, and appends the caller's clauses to its OWN title", () => {
    for (const p of [scored(0.5), NOT_LIVE]) {
      const html = pillarBarHtml("S", p, opts);
      expect(html).toContain('<span class="lg-bar-lbl">S</span>');
      // The clause lands in the TOOLTIP, not as visible markup — that is the whole rung.
      expect(html).toContain(`${COV_CLAUSE}"`);
      expect(html.replace(/<[^>]*>/g, "")).not.toContain("COV-CLAUSE");
    }
  });
  it("exact markup per arm - R1: the trailing badge strip is EMPTY, nothing after the track", () => {
    // D1 moved the percentile out; R1 took the coverage badge to the tooltip, so the bar row is
    // label + track and NOTHING else. Pinned as an EXACT whole-string match, not a `</span></span>$`
    // suffix: that suffix is unanchored on the left and a re-added trailing badge still satisfies it
    // (`…</span></span><span class="lg-pct">p61</span></span>` ends the same way).
    expect(pillarBarHtml("S", scored(0.5), opts)).toBe(
      `<span class="lg-bar" title="A-COPY 50${COV_CLAUSE}">` +
        `<span class="lg-bar-lbl">S</span>` +
        `<span class="lg-bar-track">${TICKS}<span class="lg-bar-fill a" data-css-width="50"></span></span>` +
        `</span>`,
    );
    expect(pillarBarHtml("S", NOT_LIVE, opts)).toBe(
      `<span class="lg-bar" title="NA-COPY${COV_CLAUSE}">` +
        `<span class="lg-bar-lbl">S</span>` +
        `<span class="lg-bar-track">${TICKS}</span>` +
        `</span>`,
    );
  });
  it("R1 - a falsy or absent clause adds nothing (the producer decides, not the seam)", () => {
    const bare = pillarBarHtml("S", scored(0.5), { ...opts, clauses: ["", null, undefined] });
    expect(bare).toContain('title="A-COPY 50"');
    expect(pillarBarHtml("S", scored(0.5), { ticksHtml: TICKS, titles: TITLES })).toContain(
      'title="A-COPY 50"',
    );
  });
  it("the clamp clause is name-free (name-sync discharged by construction)", () => {
    const NAMES = ["Semis", "S&P IT", "EM", "Value", "S&P 500", "ex-US", "EU-Fin", "Health",
      "Staples", "EARLY-WARN", "STRESS-NOW", "credit", "rates", "valuation", "volatility"];
    for (const name of NAMES) {
      expect(CLAMP_CLAUSE).not.toContain(name);
    }
  });

  // ── the axis clamp discloses itself, at the clamp only ────────────────
  it("G2 - the clamp clause fires at BAR_FULL_SCALE and NOT one step below (boundary)", () => {
    // 0.99 vs 1: red-demos when the seam's `>=` flips to `>`.
    const below = pillarBarHtml("S", scored(0.99), opts);
    const at = pillarBarHtml("S", scored(1), opts);
    expect(below).not.toContain(CLAMP_CLAUSE.trim().slice(0, 20));
    expect(at).toContain(CLAMP_CLAUSE.trim().slice(0, 20));
    // Non-vacuity: both fixtures really are on the SCORED branch (an `na` arm carries no clause at
    // all, so "below has none" would pass for the wrong reason).
    expect(below).toContain("lg-bar-fill");
    expect(at).toContain("lg-bar-fill");
    // A red-band 0.6 pillar (past the 0.5435 cut) paints below full and carries no clamp clause.
    const red = pillarBarHtml("S", scored(0.6), opts);
    expect(red).toContain(`lg-bar-fill r" data-css-width="60"`);
    expect(red).not.toContain(CLAMP_CLAUSE.trim().slice(0, 20));
  });
  it("G4 - the clamp clause lands after the band copy and BEFORE the caller's `clauses` tail", () => {
    expect(pillarBarHtml("S", scored(1), opts).match(/title="([^"]*)"/)[1]).toBe(`R-COPY 100${CLAMP_CLAUSE}${COV_CLAUSE}`);
  });
  it("G2 - the clamp clause is SCORED-only: the na arm is untouched", () => {
    expect(pillarBarHtml("E", NOT_LIVE, opts)).not.toContain(CLAMP_CLAUSE.trim().slice(0, 20));
  });
});

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const scopedStyle = readFileSync(here("./lab.css"), "utf8");

// ── D1 style-and-placement guards (frontend.md: EMITTED ≠ STYLED ≠ PLACED) ─────────────────────
// D1 moves the percentile badge between DOM slots, not provable from emitted markup alone; the claim
// lives in lab.css, /lab's scoped sheet.
describe("D1 - the EW percentile stacks UNDER the sort-key numeral in the danger cell", () => {
  const labSrc = readFileSync(here("./lab-board.js"), "utf8");

  it("`renderDangerNum` emits the badge INSIDE its own `.lg-glyph`, after the numeral", () => {
    const fn = labSrc.match(/function renderDangerNum\(l\) \{[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/lg-dotv[\s\S]*<\/span>`\s*\+\s*\n?\s*`\$\{pctBadge\(l\.ewPct\)\}<\/span>/);
  });

  it("…and `renderPillarBars` no longer rides it on the trailing badge slot", () => {
    const call = labSrc.match(/pillarBarHtml\(lbl, pillar, \{[\s\S]*?\}\)/);
    expect(call[0]).not.toContain("pctBadge");
  });

  it("the danger cell's `.lg-glyph` is a COLUMN - otherwise the badge lands beside the numeral", () => {
    // Emission puts the badge in the slot; only this rule puts it UNDERNEATH. Without it the cell
    // reads `12 p61~` inline and D1's ruling is silently unshipped.
    expect(scopedStyle).toMatch(
      /\.df-grid\s+\.col-danger\s+\.lg-glyph\s*\{[^}]*flex-direction:\s*column/,
    );
  });
});

describe("D1 - the ledger's height budget", () => {
  const trackRule = scopedStyle.match(/\.lg-bar-track\s*\{[^}]*\}/)[0];
  const px = (rule, prop) => Number(rule.match(new RegExp(`${prop}:\\s*(\\d+)px`))[1]);

  it("D1 - the track is thicker than the pre-D1 4px, and still fits the MEASURED 8.95px bar row", () => {
    // 8.95px is the browser-measured `.lg-bar` height (its 0.56rem/line-height:1 E/S label drives
    // it); `* { box-sizing: border-box }` puts the 1px frame INSIDE `height`. A track past that
    // number grows every ledger row — which is exactly what R6/D1 forbid.
    const h = px(trackRule, "height");
    expect(h).toBeGreaterThan(4);
    expect(h).toBeLessThanOrEqual(8);
  });
});

describe("lab-board.js wiring - renderPillarBars composes the seam with its own band copy", () => {
  // The seam's `titles` arg is injected, so the tests above pin ROUTING only. This pins that the
  // shipped caller actually passes BAR_TITLE — without it, lab.js could render clause-less titles
  // with every assertion above still green.
  const labSrc = readFileSync(here("./lab-board.js"), "utf8");
  it("passes ticksHtml, the coverage CLAUSE and BAR_TITLE[lbl] into pillarBarHtml", () => {
    const call = labSrc.match(/pillarBarHtml\(lbl, pillar, \{[\s\S]*?\}\)/);
    expect(call).not.toBeNull();
    expect(call[0]).toContain("titles: BAR_TITLE[lbl]");
    // The `covHtml` badge slot is retired: coverage reaches the seam as a
    // tooltip clause. Pinned as an exact whole-slot match — a `toContain` would still pass if the
    // badge markup were re-prepended beside the clause.
    expect(call[0]).toMatch(/clauses:\s*\[coverageClause\(l\.coverage, superGroup\)\],/);
    expect(call[0]).not.toContain("covHtml");
  });
});
