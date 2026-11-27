/*
 * The per-leg EARLY-WARN percentile badge (`pctBadge`), emitted by `renderDangerNum` and stacked under
 * the sort-key numeral inside the danger cell's own `.lg-glyph`. This file tests the helper itself,
 * which is caller-agnostic.
 *
 * Same lift idiom as `leg-coverage-badge.test.js`: `public/lab.js` is a DOM-side-effecting browser
 * module (top-level `document` wiring) and cannot be imported under vitest, but `pctBadge` is a PURE
 * helper of its one arg that closes over nothing — so we lift its source out of lab.js and
 * reconstruct it with `new Function`. That exercises the SHIPPED code rather than a hand-typed
 * mirror (which `.claude/rules/testing-project.md` records as drifting silently).
 *
 * Three layers:
 *  1. Behaviour — every arm of `PercentileCell` (src/api/types.ts) plus the absent-field case.
 *  2. Attribute safety — the helper interpolates its titles WITHOUT `esc()` (staying closure-free is
 *     what makes the lift exact), so the titles must stay attribute-safe.
 *  3. The `.est` rule body in lab.css. That every class the badge emits resolves to a selector there
 *     (`.claude/rules/frontend.md` §"A markup test proves classes are EMITTED, never STYLED or PLACED")
 *     is the badge's row in `class-coverage.test.js`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// Lift the pure `pctBadge` helper out of lab.js and reconstruct it (it closes over nothing).
const labSrc = readFileSync(here("./lab-board.js"), "utf8");
const pctBadgeSrc = labSrc.match(/function pctBadge\(ewPct\)\s*\{[\s\S]*?\n\}/);
if (!pctBadgeSrc) throw new Error("pctBadge not found in lab-board.js - the Stage 4.1 seam moved");
const pctBadge = new Function(`return (${pctBadgeSrc[0]});`)();

// lab.css — /lab's page-scoped sheet, the ONLY stylesheet the page loads for these ledger classes.
const scopedStyle = readFileSync(here("./lab.css"), "utf8");

const titleOf = (html) => html.match(/title="([^"]*)"/)?.[1];

describe("pctBadge - Stage 4.1 always-`—` percentile badge", () => {
  it("warmup ⇒ bare `—`, never a number (below warm-up is never imputed)", () => {
    const html = pctBadge({ kind: "warmup" });
    expect(html).toContain(">—</span>");
    expect(html).toMatch(/^<span class="lg-pct" title="[^"]+">—<\/span>$/);
    expect(titleOf(html)).toContain("not enough stored history");
  });

  it("na (uncomparable pillar) ⇒ bare `—`, with a title saying WHY it differs from warm-up", () => {
    const html = pctBadge({ kind: "na" });
    expect(html).toMatch(/^<span class="lg-pct" title="[^"]+">—<\/span>$/);
    expect(titleOf(html)).toContain("uncomparable");
    // The two dash arms must stay distinguishable on hover — same glyph, different reason.
    expect(titleOf(html)).not.toBe(titleOf(pctBadge({ kind: "warmup" })));
  });

  it("stale-basis (Stage 4.4 arm) ⇒ bare `—` - a stale rank is never served as a number", () => {
    const html = pctBadge({ kind: "stale-basis" });
    expect(html).toMatch(/^<span class="lg-pct" title="[^"]+">—<\/span>$/);
    expect(titleOf(html)).toContain("older engine vintage");
  });

  it("absent / unknown field ⇒ empty string, NEVER the literal `undefined`", () => {
    // An older cached payload carries no `ewPct` at all; `renderDangerNum` (post-D1 caller)
    // concatenates the result straight into markup, so a non-string or a stringified object would
    // paint as text.
    // `constructor` / `toString` are INHERITED keys on the TITLES object literal: a bare
    // `TITLES[ewPct.kind]` lookup returns a truthy function for them and paints
    // `function Object() { [native code] }` into the title attribute.
    for (const absent of [
      undefined,
      null,
      {},
      { kind: "nope" },
      { kind: "constructor" },
      { kind: "toString" },
      { kind: "hasOwnProperty" },
    ]) {
      expect(pctBadge(absent)).toBe("");
    }
    for (const arm of [{ kind: "warmup" }, { kind: "na" }, { kind: "stale-basis" }, undefined]) {
      expect(typeof pctBadge(arm)).toBe("string");
      expect(pctBadge(arm)).not.toContain("undefined");
      expect(pctBadge(arm)).not.toContain("[object Object]");
    }
  });

  it("the `pct` arm renders the rank as a BARE `pNN` (Stage 4.3 + G1 - no parentheses)", () => {
    const html = pctBadge({ kind: "pct", value: 0.62 });
    expect(html).toMatch(/^<span class="lg-pct" title="[^"]+">p62<\/span>$/);
    // Rounding, and the two ends of the scale — a rank of 0 is a REAL reading (the pillar is below
    // every stored close), and must never collapse into the `—` arms' empty/dash rendering.
    expect(pctBadge({ kind: "pct", value: 0.6249 })).toContain(">p62<");
    expect(pctBadge({ kind: "pct", value: 0 })).toContain(">p0<");
    expect(pctBadge({ kind: "pct", value: 1 })).toContain(">p100<");
    // G1's own falsifier, stated positively rather than left implicit in the anchored regex above:
    // re-adding the parens reds this line as well as the regex. Scoped to the TEXT NODE, not the
    // whole string — an unscoped `"(p"` would also scan `title=` and false-red on a future clause.
    expect(html).not.toMatch(/>[^<]*\(p/);
  });

  it("the `pct` title states the ROLL-OFF consequence: the reading moves with NO new data", () => {
    // Spec §2's non-negotiable copy clause. The badge must never read as fresh-close-driven.
    const title = titleOf(pctBadge({ kind: "pct", value: 0.62 }));
    expect(title).toMatch(/ROLLING WINDOW/);
    expect(title).toMatch(/moves with NO new data/);
    expect(title).toMatch(/falls out the back/);
    // And it is a DIFFERENT title from the three dash arms (a shared title would leave the
    // consequence unstated on the only arm that shows a number).
    expect(title).not.toBe(titleOf(pctBadge({ kind: "warmup" })));
  });

  it("a MALFORMED `pct` payload renders nothing - never `pNaN`", () => {
    for (const bad of [
      { kind: "pct" },
      { kind: "pct", value: null },
      { kind: "pct", value: "0.6" },
      { kind: "pct", value: NaN },
      { kind: "pct", value: Infinity },
    ]) {
      expect(pctBadge(bad)).toBe("");
    }
  });
});

describe("window-length copy parity - lab-board.js's title literal vs the TS constant", () => {
  it("the `pct` title names ECDF_WINDOW, so the copy cannot drift from the arithmetic", async () => {
    // lab.js is unbundled browser ESM and cannot import from src/, so the window length is a
    // literal in its title copy. This is the pin that keeps the two in step: bump ECDF_WINDOW
    // without updating the sentence and this reds. (`.ts` specifier, per .claude/rules/frontend.md.)
    const { ECDF_WINDOW } = await import("../src/ecdf-window.ts");
    const title = titleOf(pctBadge({ kind: "pct", value: 0.5 }));
    expect(title).toContain(`last ${ECDF_WINDOW} stored closes`);
    expect(title).toContain(`${ECDF_WINDOW}-close window`);
  });
});

describe("stale-basis names the two vintages (W4 Stage 4.4)", () => {
  it("the title carries BOTH the stored and the live generator, and still paints `—`", () => {
    // The actionable half of the arm: "an older engine vintage" alone does not say WHICH, so an
    // operator cannot tell a pending regen from a deploy running an unexpected formula.
    const html = pctBadge({ kind: "stale-basis", stored: "ew-v0", live: "ew-65d7cf6d890f" });
    expect(html).toContain(">—</span>"); // never a number, whatever the tags say
    const title = titleOf(html);
    expect(title).toContain("stored ew-v0");
    expect(title).toContain("live ew-65d7cf6d890f");
  });

  it("a HOSTILE generator string cannot break out of the title attribute", () => {
    // These are the ONLY server-supplied strings pctBadge interpolates, and it does not call esc().
    // The whitelist is the guard; this is the fixture that proves it bites.
    const html = pctBadge({
      kind: "stale-basis",
      stored: '" onmouseover="alert(1)',
      live: "<script>x</script>",
    });
    expect(html).toMatch(/^<span class="lg-pct" title="[^"]*">—<\/span>$/);
    // The claim is BREAKOUT-safety, not word-scrubbing: every character that could close the
    // attribute, open a tag, or start a new attribute is gone. (`onmouseover` survives as inert
    // letters — with no `=` and no `"` it cannot become an attribute.)
    expect(titleOf(html)).not.toMatch(/["'<>&=/]/);
    // Non-vacuity: the sanitizer kept the harmless characters rather than blanking everything, so
    // the assertion above is not passing on an empty string.
    expect(titleOf(html)).toContain("alert1");
  });

  it("missing tags degrade to `?`, never the literal `undefined`", () => {
    // An older server (pre-4.4) can still emit a bare `{kind:"stale-basis"}` from a cached payload.
    const title = titleOf(pctBadge({ kind: "stale-basis" }));
    expect(title).toContain("stored ?, live ?");
    expect(title).not.toContain("undefined");
  });
});

describe("mixed-basis marking on the `pct` arm (W4 Stage 4.4, the `basis` half)", () => {
  const spanned = (extra = {}) =>
    pctBadge({ kind: "pct", value: 0.62, basisSpans: ["2026-05-15"], ...extra });

  it("`basisSpans` renders the `~` marker and NAMES the date", () => {
    const html = spanned();
    expect(html).toContain(">p62~<");
    expect(html).toMatch(/class="lg-pct est"/);
    const title = titleOf(html);
    expect(title).toContain("2026-05-15");
    expect(title).toContain("SPANS a rates-roster change");
    // … and the plain (unspanned) arm names no date — the vacuity guard for the line above.
    expect(titleOf(pctBadge({ kind: "pct", value: 0.62 }))).not.toContain("2026-05-15");
  });

  it("MULTIPLE change dates are all named", () => {
    const title = titleOf(spanned({ basisSpans: ["2026-05-15", "2026-05-25"] }));
    expect(title).toContain("2026-05-15");
    expect(title).toContain("2026-05-25");
  });

  it("HOSTILE / malformed span values cannot break out of the title attribute", () => {
    const html = spanned({ basisSpans: ['" onmouseover="alert(1)', 12345, null, "2026-05-15"] });
    expect(html).toMatch(/^<span class="lg-pct est" title="[^"]*">p62~<\/span>$/);
    const title = titleOf(html);
    expect(title).not.toMatch(/["'<>&=]/);
    expect(title).toContain("2026-05-15"); // non-vacuity: the good date survived the sanitizer
    expect(title).not.toContain("undefined");
    expect(title).not.toContain("alert");
  });

  it("a non-array `basisSpans` is ignored, not stringified", () => {
    for (const bad of ["2026-05-15", {}, 7]) {
      const html = pctBadge({ kind: "pct", value: 0.62, basisSpans: bad });
      expect(html).toBe(pctBadge({ kind: "pct", value: 0.62 }));
    }
  });
});

describe("the badge's `.est` rule body", () => {
  // That `.lg-pct` / `.lg-pct.est` resolve in lab.css at all is a row of `class-coverage.test.js`.
  it("D3/R3 - the `.est` register is SLANT, never the band palette", () => {
    // The rung's acceptance: no ledger text is amber. `--elev` IS `--state-amber` (lab.css's token
    // block), so re-introducing the old `color: var(--elev)` lift would make a provenance note read
    // as an alert on a calm board — the single-hue commitment says band colour means band only.
    // Comments are stripped first: a future `/* … .lg-pct.est { … } … */` block would otherwise
    // satisfy the match ahead of the real rule and the pin would grade prose instead of CSS.
    const rule = scopedStyle.replace(/\/\*[\s\S]*?\*\//g, "").match(/\.lg-pct\.est\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull(); // non-vacuity: the regex below is checking a real rule body
    // Both halves of the borrowed `.lg-dotv.trend-gated` register, so dropping either one reds.
    expect(rule[1]).toMatch(/font-style:\s*italic/);
    expect(rule[1]).toMatch(/opacity:\s*0?\.75/);
    expect(rule[1]).not.toMatch(/--elev|--state-amber|color:/);
  });
});
