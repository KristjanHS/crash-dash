// lab-board.js source-scan guards — folded from lab-board.skeleton / lab.quadrant-quotes /
// lab.lag-gate / lab.ledger-legend (.test.js). Each section keeps its own header.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test } from "vitest";

const LAB_JS = readFileSync(fileURLToPath(new URL("./lab-board.js", import.meta.url)), "utf8");

// ── dangerFieldSkeletonHtml (ex-lab-board.skeleton.test.js) ─────────────────────────────────────
// lab-board.js dangerFieldSkeletonHtml — the ONE #dangerField build-skeleton producer: lab.js
// buildBench interpolates it and overview.js buildSkeleton writes it, so the legend cannot fork.
// Host presence/ordering/collapse of the skeleton is owned by the danger-ledger legend sections below.
describe("dangerFieldSkeletonHtml", () => {
  it("neither consumer carries its own copy of the legend markup", async () => {
    // Source scan: the legend lead sentence lives ONLY in the producer.
    const { readFileSync } = await import("node:fs");
    for (const f of ["public/lab.js", "public/overview.js"]) {
      expect(readFileSync(f, "utf8"), f).not.toContain("df-lgd-lead");
    }
  });
});

// ── renderQuadrant spliced quotes (ex-lab.quadrant-quotes.test.js) ──────────────────────────────
/*
 * View-C rotation quadrant — the SPLICED-QUOTE guard over `renderQuadrant` (lab-board.js).
 *
 * A template literal is valid JS whatever its attribute quoting looks like, so malformed HTML from an
 * unbalanced-quote fragment is invisible to `node --check`. `lab.js` runs module-level DOM/`localStorage`
 * side effects, so it can never be IMPORTED from a no-jsdom test (`.claude/rules/frontend.md`). This
 * guard therefore reads the source text, the same seam `write-seam.test.js` uses, and asserts a
 * property that only holds for whole-attribute fragments: every `"` in the function body pairs up.
 */

/** The source text of `function <name>(...)`, brace-matched to its closing `}`. */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in lab-board.js`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

/** Every template literal in `src`, with its `${…}` substitutions removed — so only the LITERAL
 *  markup text of each fragment is left. Handles templates nested inside a substitution. */
function templateFragments(src) {
  const out = [];
  const scan = (i, depth, acc) => {
    // `i` points just past an opening backtick; returns the index just past its closing backtick.
    let text = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        out.push(text);
        return i + 1;
      }
      if (c === "$" && src[i + 1] === "{") {
        // Skip the substitution, but recurse into any template literal inside it.
        let braces = 1;
        i += 2;
        while (i < src.length && braces > 0) {
          if (src[i] === "`") i = scan(i + 1, depth + 1, acc);
          else {
            if (src[i] === "{") braces++;
            else if (src[i] === "}") braces--;
            i++;
          }
        }
        continue;
      }
      text += c;
      i++;
    }
    throw new Error("unterminated template literal");
  };
  for (let i = 0; i < src.length; i++) if (src[i] === "`") i = scan(i + 1, 0, out) - 1;
  return out;
}

describe("renderQuadrant emits whole attributes, not spliced quotes", () => {
  const body = functionBody(LAB_JS, "renderQuadrant");
  const fragments = templateFragments(body);

  // Non-vacuity: a rename or a failed extraction would leave an empty/foreign body that trivially
  // satisfies the quote check. Pin that we really grabbed the quadrant painter, and that the
  // fragment scanner really found its markup.
  test("the extracted body is the quadrant painter", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("rrg-leg");
    expect(fragments.filter((f) => f.includes("data-sleeve=")).length).toBeGreaterThan(0);
    expect(fragments.filter((f) => f.includes('"')).length).toBeGreaterThan(5);
  });

  // A whole-attribute fragment always carries an even number of `"`; the spliced idiom is exactly
  // the shape that leaves one dangling for a LATER fragment to close.
  test('every template fragment closes its own `"`', () => {
    const spliced = fragments.filter((f) => ((f.match(/"/g) ?? []).length) % 2 === 1);
    expect(spliced).toEqual([]);
  });
});

// ── resolveField lag gate (ex-lab.lag-gate.test.js) ──────────────────────────────────────────
/**
 * `resolveField`'s `freshnessMissing` branch (`public/lab-board.js`, importable — `cell-observed.test.js`
 * invokes it). Pinned by SOURCE SLICE because `unmeasuredLagMark`'s own cases pass with the gate REVERTED.
 */

/** One top-level function's source, by name — `lab.family-lag.test.js`'s slicer. */
function bodyOf(name) {
  const m = LAB_JS.match(new RegExp(`\\n(?:export )?function ${name}\\(`));
  expect(m, `${name} is a top-level function in lab-board.js`).toBeTruthy();
  const rest = LAB_JS.slice(m.index + 1);
  const end = rest.search(/\n(?:export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("resolveField gates the Lag column on the A4 freshnessMissing flag", () => {
  const body = bodyOf("resolveField");

  // Non-vacuity for the slicer: this really is the function that builds the ledger's lag marks.
  it("the slice really is resolveField", () => {
    expect(body).toContain("d.field.legRows.map");
    expect(body).toContain("lagMark:");
    expect(body).not.toContain("function decorateCell");
  });

  it("reads freshnessMissing STRICTLY - a pre-A4 cached payload must not trip the branch", () => {
    expect(body).toMatch(/d\.freshnessMissing === true/);
  });

  it("swaps the per-leg mark for the unmeasured `-` and DROPS the count when unstamped", () => {
    // The `⌁` tier producer must be on the stamped side of the ternary, never unconditional.
    expect(body).toMatch(/lagMark:\s*unstamped\s*\?\s*unmeasuredLagMark\(\)\s*:\s*legLagMark\(/);
    // `◌ⁿ` is the fabricated count that put "6 families" on screen — it must be null when unstamped.
    expect(body).toMatch(/cellLagMark:\s*unstamped\s*\?\s*null\s*:\s*legCellLagMark\(/);
  });

  it("threads the same flag into the drill-down census, which reads the SAME observed counts", () => {
    // Review finding, same commit: `cellTipHtml`'s footer printed `0 fresh · 8 lag · 0 absent` one
    // click below the cell the column had just stopped lying about.
    expect(bodyOf("decorateCell")).toContain("unstamped");
    expect(body).toMatch(/decorateCell\(c, l, memberState, membersByFamily, foldByMember, unstamped, model\)/);
  });
});

// ── danger-ledger legend (ex-lab.ledger-legend.test.js) ──────────────────────────────────────
/**
 * The ONE guard the danger-ledger legend collapse owes.
 *
 * The collapse hides ~1100 characters of REFERENCE COPY behind a disclosure. The one regression it
 * can plausibly cause is swallowing the thing that is NOT reference copy: `#dfFlipLegend`, the
 * `⌁ COVERAGE — …` line (`coverage-marks.js`), which is a LIVE READING of an active degradation —
 * the band was floored because a feed went dark. It renders "" on a healthy run, so it costs
 * nothing when silent; hiding it behind a click would hide the degradation itself.
 *
 * It was previously glued to the TAIL of the collapsed paragraph, so the failure mode is one
 * careless nesting away and leaves no other trace: the legend closes, the coverage line vanishes,
 * and every other test stays green.
 *
 * Source-level over the skeleton's ONE producer — `dangerFieldSkeletonHtml` in `lab-board.js`
 * (interpolated by lab.js buildBench AND written by overview.js buildSkeleton), read as a file
 * like `lab.family-lag.test.js` reads lab.js.
 */

/** The `#dfLegend` element, from its opening tag to the `.df-grid-wrap` that follows it — the
 *  skeleton is one template literal, so the slice is a plain substring walk. */
function legendSlice(src) {
  const start = src.indexOf('<div class="df-legend" id="dfLegend"');
  if (start < 0) return "";
  const end = src.indexOf('<div class="df-grid-wrap"', start);
  return end < 0 ? "" : src.slice(start, end);
}

describe("danger-ledger legend disclosure - the live COVERAGE line is not swallowed", () => {
  const legend = legendSlice(LAB_JS);

  // Non-vacuity: every assertion below quantifies over this slice, so a moved/renamed legend would
  // make them all pass against an empty string.
  it("the legend body really exists in the skeleton (the slice is not empty)", () => {
    expect(legend.length, "#dfLegend not found in lab-board.js's dangerFieldSkeletonHtml").toBeGreaterThan(500);
  });

  it("the toggle's aria-controls target is #dfLegend, and the panel starts hidden", () => {
    const btn = LAB_JS.match(/<button class="df-legend-toggle"[^>]*>/);
    expect(btn, "the .df-legend-toggle button is gone").not.toBeNull();
    expect(btn[0]).toContain('aria-controls="dfLegend"');
    expect(btn[0]).toContain('aria-expanded="false"');
    expect(legend.slice(0, legend.indexOf(">") + 1), "#dfLegend must start collapsed").toContain("hidden");
  });

  it("#dfFlipLegend is OUTSIDE the collapsed body - a live reading is never behind a click", () => {
    expect(LAB_JS, "the COVERAGE line host disappeared from the skeleton").toContain('id="dfFlipLegend"');
    expect(legend, "#dfFlipLegend was nested inside #dfLegend - the COVERAGE line is now hidden by default").not.toContain(
      "dfFlipLegend",
    );
  });
});

describe("danger-ledger legend - the unified 'held' row decodes the chip badge", () => {
  const legend = legendSlice(LAB_JS);
  // The chip badge (lab-board.js legSpan) paints a bare `held` word for the directional fold; the row
  // below is what decodes it, and names BOTH mechanisms so the cell overline decodes off the same word.
  it("defines 'held' for the fold AND the hold window", () => {
    expect(legend, "the unified held legend row is missing").toContain('<span class="leg-held">held</span>');
    expect(legend, "the fold mechanism is undefined").toContain("directional 2-close FOLD");
    expect(legend, "the hold-window mechanism is undefined").toContain("signal-hold WINDOW");
  });
});

// ── The UNDER-TABLE disclosure ([USER] 2026-08-29) ────────────────────────────────────────────
// Everything below the ledger grid — the held-leg trajectory log and the `#dfFoot` sentence — ships
// COLLAPSED behind `DETAIL ▸`. Two things can silently break it: the body losing `hidden` (it
// re-expands and nobody notices, because every other test reads the hosts, not their visibility),
// and a host drifting OUT of the wrapper (it stays visible while the toggle claims to control it).
// The toggle is wired by `aria-controls` in lab-board.js `buildDangerField`, so the id link is the
// contract — a sibling walk would not find it.
describe("danger-ledger under-table disclosure", () => {
  /** `#dfBelow`, from its opening tag to the producer's closing template-literal backtick
   *  (the skeleton is #dangerField's CHILDREN only — the `</section>` lives in lab.js). */
  const belowSlice = (() => {
    const start = LAB_JS.indexOf('<div class="df-below" id="dfBelow"');
    if (start < 0) return "";
    const end = LAB_JS.indexOf("`;", start);
    return end < 0 ? "" : LAB_JS.slice(start, end);
  })();

  it("ships the body collapsed, behind a toggle wired to it by id", () => {
    const btn = LAB_JS.match(/<button class="df-below-toggle"[^>]*>/);
    expect(btn, "the .df-below-toggle button is gone").not.toBeNull();
    expect(btn[0]).toContain('aria-controls="dfBelow"');
    expect(btn[0]).toContain('aria-expanded="false"');
    expect(belowSlice.slice(0, belowSlice.indexOf(">") + 1), "#dfBelow must start collapsed").toContain("hidden");
    expect(LAB_JS.indexOf("df-below-toggle")).toBeLessThan(LAB_JS.indexOf('class="df-below"'));
  });

  it("encloses BOTH under-table hosts - the held-path log and the footer", () => {
    expect(belowSlice, "#heldPathHost drifted out of the disclosure").toContain('id="heldPathHost"');
    expect(belowSlice, "#dfFoot drifted out of the disclosure").toContain('id="dfFoot"');
    // Non-vacuity: the GRID stays outside — a collapsed ledger still shows its table.
    expect(belowSlice).not.toContain("dfGridWrap");
    expect(LAB_JS.indexOf('id="dfGridWrap"')).toBeLessThan(LAB_JS.indexOf('id="dfBelow"'));
  });
});
