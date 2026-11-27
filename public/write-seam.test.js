// Guards the setHTML() write seam (defined in help-bar.js, consumed by app.js and lab.js).
//
// The help glyphs are in-flow 24px buttons on ~83 [title] hosts. A bare `el.innerHTML = …`
// destroys them all; if they are restored later (a rAF, a MutationObserver microtask) the
// document transiently shrinks ~227px, and at max scroll — where reading the Zone-D detail
// chart always parks you — the browser clamps scrollY down irreversibly. That was the residual
// ~54px viewport jump. setHTML() exists so decoration happens in the same task as the write.
//
// scripts/preview/mode-shift-probe.mjs catches a re-introduction at runtime via its `dip`
// assertion, but only if an rAF tick lands while the glyph-less layout is committed. This test
// is the timing-independent half: it fails on the *source*, so a throttled or coalesced restore
// cannot slip through. Together they cover the class.
//
// Scope (2026-08-04): the lint runs over exactly the
// two files that wire a help bar — `app.js` (index.html) and `lab.js` (lab.html). /lab carried ~19 bare
// writes and its own hand-copied write-then-decorate two-liners, so the invariant was a convention a
// reviewer had to remember; the sweep converted every title-capable site and this file is what makes
// the remainder enforceable.
//
// `journal.js` is deliberately OUT of scope even though it holds two raw `$("list").innerHTML =` writes:
// journal.html loads no help bar (its only module script is journal.js, which imports nothing from
// help-bar.js), and its markup producer `entryList` (journal-view.js) emits zero `title=`. There is no
// glyph on that page to destroy, and routing it through setHTML would inject ⓘ buttons that nothing
// wires. Re-check both facts before adding a `[title]` or a help bar to that page.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// The seam function itself lives in help-bar.js so /lab can import the identical writer; its
// `el.innerHTML = html;` line — the one raw write this whole guard is built around — is therefore
// pinned in ITS file, not in either consumer.
const SEAM_SRC = read("./help-bar.js");
const SOURCES = {
  "app.js": read("./app.js"),
  "lab.js": read("./lab.js"),
  "families-board.js": read("./families-board.js"),
  "lab-board.js": read("./lab-board.js"),
  "lab-reader.js": read("./lab-reader.js"),
  "lab-chips.js": read("./lab-chips.js"),
  "detail-tab.js": read("./detail-tab.js"),
  "overview.js": read("./overview.js"),
};

/**
 * Every line that writes markup into an element, excluding comments. Four shapes, because all four
 * destroy (or bypass) the glyphs the seam exists to keep: `innerHTML =`, `innerHTML +=`,
 * `outerHTML =`/`+=`, and `insertAdjacentHTML(`. An append is not a lesser case — it lays out the new
 * markup unglyphed and leaves any `[title]` it brought undecorated forever.
 * ⚠ Comparisons stay out: the `(?!=)` lookahead rejects `=== `/`== `, and `!==` never matches the
 * `\s*\+?=` step at all.
 * ⚠ The `=` may be the LAST character on the line — prettier breaks a long concatenation onto the
 * next line (`dfFoot.innerHTML =` ⏎ `  base + …`). An earlier `=[^=]` form silently skipped every
 * such site, which is how five of lab.js's writes went unseen (measured at the time: the quadrant
 * box, `#firing`, `dfFoot`, the R4 knobs and the episode-replay host); `(?!=)` keeps them in scope.
 */
const WRITE_SHAPE = /\.(?:inner|outer)HTML\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(/;

const writesIn = (src) =>
  src
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => WRITE_SHAPE.test(text))
    .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*"));

/**
 * Named raw writers, per file. Each entry states WHY the site cannot host a `[title]` — the only
 * admissible reason. Anything else routes through setHTML(el, html).
 */
const ALLOWED = {
  "app.js": [],
  "families-board.js": [],
  "lab.js": [
    // buildBench's skeleton: zero `title=` in the template, and the build-time `decorateHelp(lab)`
    // a few lines later walks this very host — it is the root that pass is given.
    { name: "buildBench skeleton", re: /^lab\.innerHTML = `$/ },
    // applyReplay's standalone host: one empty <section>, no attributes beyond id/class/aria-label.
    // renderReplay then fills it through the seam.
    { name: "applyReplay host skeleton", re: /^lab\.innerHTML = `<section class="replay-card"/ },
    // A self-contained plain-text error <p> built from an Error message; no producer, no title.
    { name: "episode-replay load error", re: /^host\.innerHTML = `<p class="erp-empty">/ },
  ],
  "lab-board.js": [],
  "lab-reader.js": [],
  "lab-chips.js": [
    // buildPicker's reset: a clear, not a markup write. Nothing to decorate.
    { name: "buildPicker clear", re: /^el\.innerHTML = "";/ },
  ],
  "detail-tab.js": [],
  "overview.js": [],
};

describe("innerHTML write seam", () => {
  // ── Vacuity anchors ────────────────────────────────────────────────────────────────────────
  // Deliberately NOT the allowlist: the sweep DRAINS that population, so an allowlist-anchored
  // floor would go green-forever exactly as the fix lands (`.claude/rules/testing-project.md`
  // §"A guard's vacuity anchor must not certify the thing it exists to catch"). These anchor on
  // what the drain MOVES instead — the seam's own definition, its export, and the one raw writer
  // the sweep is not allowed to remove.
  it("the extractor can see every write shape (it is not a regex that matches nothing)", () => {
    const probe = [
      "el.innerHTML = html;", // 1 single-line
      "dfFoot.innerHTML =", // 2 prettier line-break form — the shape `=[^=]` used to miss
      "  base + more();",
      "el.innerHTML += chipHtml();", // 4 append — unglyphed markup, same bug
      "el.outerHTML = html;", // 5 replaces the host itself
      "el.outerHTML += html;", // 6
      'el.insertAdjacentHTML("beforeend", html);', // 7 the no-assignment shape
      'if (x.innerHTML === "") return;', // a comparison, never a write
      'if (x.innerHTML !== "") return;', // …and its negation
      "// host.innerHTML = `<p>x</p>`;", // a commented-out write
      " * el.innerHTML = html;", // a docblock line
    ].join("\n");
    expect(writesIn(probe).map((w) => w.line)).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it("the seam exists exactly once, exported, and both consumers were really read", () => {
    const seam = writesIn(SEAM_SRC).filter(({ text }) => text === "el.innerHTML = html;");
    expect(seam, "setHTML's own `el.innerHTML = html;` must exist exactly once").toHaveLength(1);
    expect(SEAM_SRC, "…and it is exported so app.js/lab.js share ONE writer").toMatch(
      /export function setHTML\(el, html\)/,
    );
    // A misread/empty source would make the rogue sweep below vacuously green.
    expect(SOURCES["app.js"]).toContain("function renderZoneA(");
    expect(SOURCES["lab.js"]).toContain("function buildBench(");
    expect(SOURCES["families-board.js"]).toContain("function renderFamiliesBoard(");
    expect(SOURCES["lab-board.js"]).toContain("function buildTiles(");
    expect(SOURCES["lab-reader.js"]).toContain("function renderReader(");
    expect(SOURCES["lab-chips.js"]).toContain("function buildPicker(");
    expect(SOURCES["detail-tab.js"]).toContain("function renderDetailTab(");
    expect(SOURCES["overview.js"]).toContain("function buildSkeleton(");
    // Both consumers import the ONE writer rather than hand-rolling write-then-decorate.
    for (const src of Object.values(SOURCES)) expect(src).toMatch(/import \{[^}]*setHTML[^}]*\} from "\.\/help-bar\.js"/);
  });

  // ── The lint ───────────────────────────────────────────────────────────────────────────────
  for (const [file, src] of Object.entries(SOURCES)) {
    it(`${file}: routes every markup write through setHTML, which decorates in the same task`, () => {
      const writes = writesIn(src);
      // Each allowlist entry must still match something: a stale entry is a hole in the lint.
      for (const { name, re } of ALLOWED[file]) {
        expect(writes.filter((w) => re.test(w.text)), `allowlisted raw writer "${name}" no longer exists in ${file} - drop the entry`).toHaveLength(1);
      }
      const rogue = writes.filter((w) => !ALLOWED[file].some(({ re }) => re.test(w.text)));
      expect(
        rogue,
        `bare innerHTML write(s) found - route through setHTML(el, html):\n` +
          rogue.map(({ line, text }) => `  ${file}:${line}  ${text}`).join("\n"),
      ).toEqual([]);
    });
  }

  it("keeps the deferred-decoration machinery deleted", () => {
    // A MutationObserver callback is a microtask, so it still runs after the synchronous
    // forced layout that commits the scroll clamp. rAF is a whole frame later. Neither can
    // fix this — the write is the only point early enough.
    for (const src of [SEAM_SRC, ...Object.values(SOURCES)]) {
      expect(src).not.toMatch(/MutationObserver\s*\(/);
      expect(src).not.toMatch(/requestAnimationFrame\s*\(/);
    }
  });
});
