/*
 * CSS custom-property parity for the DASHBOARD's chart seams.
 *
 * index.html carries NO scoped <style> block — it links styles.css and nothing else. So a
 * `var(--x)` emitted by a chart module resolves ONLY if `--x` is declared in styles.css.
 * When it isn't, the SVG presentation attribute is invalid and the path paints NOTHING:
 * markup tests stay green, the snapshot stays green, and the line is invisible in prod.
 * lab.html has no <style> either (its page styles live in lab.css): the /lab describe resolves every
 * var() in the sheets lab.html loads (<link rel=stylesheet> + any <style>) against their union.
 *
 * This is the `.claude/rules/frontend.md` §"A markup test proves classes are EMITTED, never STYLED or
 * PLACED" class-parity guard applied to custom properties.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// Modules whose output is injected into index.html (no scoped styles there).
const DASHBOARD_CHART_MODULES = ["./detail-chart.js", "./chart-primitives.js", "./sparkline.js", "./ladder-chart.js"];

const declaredInStyles = new Set(
  [...readFileSync(here("./styles.css"), "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);

describe("dashboard chart modules only reference CSS vars styles.css declares", () => {
  for (const mod of DASHBOARD_CHART_MODULES) {
    it(`${mod} - every var(--x) resolves`, () => {
      const src = readFileSync(here(mod), "utf8");
      const used = [...src.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
      const missing = [...new Set(used)].filter((v) => !declaredInStyles.has(v));
      expect(missing).toEqual([]);
    });
  }

  // Non-vacuity: the guard must be able to see a var that styles.css does not declare.
  // `--accent-ink` is the real one that broke — declared in lab.html only.
  it("would catch a lab-only var (the 2026-07-23 failure)", () => {
    expect(declaredInStyles.has("--trend-line")).toBe(true);
    expect(declaredInStyles.has("--accent-ink")).toBe(false);
  });

  // Non-vacuity for the EXSH_GATE MA50 tone: the sweep above must actually reach `--trend-line-white`
  // (a chart module references it); the sweep itself proves styles.css declares it.
  it("reaches --trend-line-white: a chart module uses it", () => {
    const users = DASHBOARD_CHART_MODULES.filter((mod) => readFileSync(here(mod), "utf8").includes("var(--trend-line-white)"));
    expect(users.length).toBeGreaterThan(0);
  });
});

// The /lab page: every sheet it loads, comments stripped (a commented-out link/decl/use counts for nothing).
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const labHtml = readFileSync(here("./lab.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const labSheetHrefs = [...labHtml.matchAll(/<link\b[^>]*>/g)]
  .map((m) => m[0])
  .filter((tag) => /\brel=["']stylesheet["']/.test(tag))
  .map((tag) => tag.match(/\bhref=["']([^"']+)["']/)[1]);
const labStyleBlocks = [...labHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const labCss = stripCss([...labSheetHrefs.map((h) => readFileSync(here(h), "utf8")), ...labStyleBlocks].join("\n"));
const declaredOnLab = new Set([...labCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// A var WITH a fallback — var(--x, y) — counts as resolved: it paints y, never nothing. Only bare uses are checked.
const usedOnLab = new Set([...labCss.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));

describe("/lab page only references CSS vars the sheets it loads declare", () => {
  it("lab.html - every bare var(--x) across its sheets resolves", () => {
    expect([...usedOnLab].filter((v) => !declaredOnLab.has(v))).toEqual([]);
  });

  // Non-vacuity: `--accent-ink`/`--faint` uses also occur in styles.css, so only `declaredOnLab.has("--accent-ink")`
  // (declared in lab.css alone) proves lab.css was read; the last anchor proves the undeclared filter can go non-empty.
  it("reads styles.css + lab.css and sees their var() uses", () => {
    expect(labSheetHrefs).toEqual(expect.arrayContaining(["./styles.css", "./lab.css"]));
    expect(usedOnLab.has("--accent-ink")).toBe(true);
    expect(declaredOnLab.has("--accent-ink")).toBe(true);
    expect(usedOnLab.has("--faint")).toBe(true);
    expect([...usedOnLab].some((v) => !declaredInStyles.has(v))).toBe(true);
  });
});
