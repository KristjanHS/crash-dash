// The CSP-safe geometry seam (`inline-pos.js`) + the file-wide lint that keeps its defect class from
// coming back. Why the class exists: `.claude/rules/frontend.md` §Inline style attributes are dead in prod.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPositions, posAttrs } from "./inline-pos.js";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** A minimal element stand-in: `style.setProperty` records, `getAttribute` reads a plain map.
 *  There is no jsdom in this repo, and the seam touches exactly these three DOM methods. */
function fakeEl(attrs) {
  const applied = {};
  return {
    attrs,
    applied,
    style: { setProperty: (k, v) => (applied[k] = v) },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}
const fakeRoot = (els) => ({ querySelectorAll: () => els });

describe("posAttrs - the markup side", () => {
  it("emits one numeric data attribute per supplied property", () => {
    expect(posAttrs({ left: 12.9 })).toBe(' data-css-left="12.9"');
    expect(posAttrs({ left: 10, top: 20.5 })).toBe(' data-css-left="10" data-css-top="20.5"');
    expect(posAttrs({ width: 93 })).toBe(' data-css-width="93"');
  });

  // Absent must stay ABSENT, not become 0% — a pinned-at-zero mark is a wrong claim, not a gap.
  it("emits nothing for a missing, null or non-finite value", () => {
    expect(posAttrs({})).toBe("");
    expect(posAttrs(null)).toBe("");
    expect(posAttrs({ left: null, top: undefined, width: NaN })).toBe("");
    expect(posAttrs({ left: Infinity })).toBe("");
  });

  // The whole point of the seam: no `style=` can leave it, whatever it is handed.
  it("never emits a style attribute", () => {
    expect(posAttrs({ left: 1, top: 2, width: 3 })).not.toContain("style");
  });
});

describe("applyPositions - the DOM side", () => {
  it("applies each data attribute as a percentage through CSSOM", () => {
    const el = fakeEl({ "data-css-left": "12.9", "data-css-width": "93" });
    applyPositions(fakeRoot([el]));
    expect(el.applied).toEqual({ left: "12.9%", width: "93%" });
  });

  it("leaves untouched what it was not given, and skips a junk value", () => {
    const el = fakeEl({ "data-css-top": "not-a-number" });
    applyPositions(fakeRoot([el]));
    expect(el.applied).toEqual({});
  });

  it("is idempotent - a second pass sets the same values", () => {
    const el = fakeEl({ "data-css-left": "40" });
    applyPositions(fakeRoot([el]));
    applyPositions(fakeRoot([el]));
    expect(el.applied).toEqual({ left: "40%" });
  });

  it("round-trips what posAttrs emitted", () => {
    const attrs = {};
    for (const m of posAttrs({ left: 62.5, width: 10 }).matchAll(/(data-css-[a-z]+)="([^"]+)"/g))
      attrs[m[1]] = m[2];
    const el = fakeEl(attrs);
    applyPositions(fakeRoot([el]));
    expect(el.applied).toEqual({ left: "62.5%", width: "10%" });
  });

  it("degrades silently on a DOM-less root", () => {
    expect(() => applyPositions(null)).not.toThrow();
    expect(() => applyPositions({})).not.toThrow();
  });
});

// ── The file-wide lint ────────────────────────────────────────────────────────────────────────
// A seam-local test only proves THIS seam is clean. The defect was five separate sites in four
// files, each independently reasonable-looking, so the guard has to be the population.
const SRC_DIR = here(".");
const PROD_FILES = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
  .sort();

describe("no public/ module emits an inline style attribute (prod CSP drops it)", () => {
  // Vacuity anchors: the population is real and the matcher can actually see a violation.
  it("reads a real population and the matcher is not a regex that matches nothing", () => {
    expect(PROD_FILES.length).toBeGreaterThan(30);
    expect(PROD_FILES).toContain("band-panel.js");
    const probe = ['`<span style="width:${p}%">`', "`<i style='color:red'>`"];
    for (const p of probe) expect(styleAttrsIn(p)).toHaveLength(1);
    expect(styleAttrsIn('// a comment mentioning style="x"')).toHaveLength(0);
  });

  it("no production file carries `style=\"…\"` in emitted markup", () => {
    const offenders = Object.fromEntries(
      PROD_FILES.map((f) => [f, styleAttrsIn(readFileSync(here(f), "utf8"))]).filter(([, hits]) => hits.length),
    );
    expect(offenders).toEqual({});
  });
});

/** Every `style="…"` / `style='…'` OUTSIDE a comment. Comments are excluded because this file and
 *  the seams it guards discuss the forbidden form in prose — a lint that its own rationale trips is
 *  a lint people delete. Line comments and `/* … *\/` blocks are stripped first. */
function styleAttrsIn(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/gm, "");
  return [...code.matchAll(/\bstyle\s*=\s*["']/g)].map((m) => m[0]);
}

describe("the applier is wired into the ONE markup writer", () => {
  const SEAM = readFileSync(here("help-bar.js"), "utf8");
  it("setHTML applies positions in the same task as the write", () => {
    expect(SEAM).toMatch(/import \{ applyPositions \} from "\.\/inline-pos\.js";/);
    expect(SEAM).toMatch(/el\.innerHTML = html;\n(.*\n)*?\s*applyPositions\(el\);/);
  });

  // Every emitter must ride the seam rather than hand-rolling the attribute name — a hand-typed
  // `data-css-left="…"` in a template would work today and silently drift if POS_ATTR is renamed.
  it("every emitter imports posAttrs, and the attribute names live in ONE table", () => {
    for (const f of ["band-panel.js", "sub-dangers.js", "lab-board.js"]) {
      const src = readFileSync(here(f), "utf8");
      expect(src, `${f} emits geometry`).toMatch(/posAttrs\(\{/);
      expect(src, `${f} imports the seam`).toMatch(/import \{ posAttrs \} from "\.\/inline-pos\.js";/);
      expect(src.replace(/\/\*[\s\S]*?\*\//g, ""), `${f} hand-types no data-css-* attribute`).not.toMatch(
        /data-css-/,
      );
    }
  });
});
