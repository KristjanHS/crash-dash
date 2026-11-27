/**
 * `bundlePage` (E1 remedy): one entry per page, tag order preserved, shared modules deduped once.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { bundlePage } from "./bundle-public.js";

const dir = mkdtempSync(join(tmpdir(), "bundle-public-"));
const w = (name: string, body: string) => writeFileSync(join(dir, name), body);
const page = (name: string, ...srcs: string[]) =>
  w(name, `<!doctype html><body>\n${srcs.map((s) => `  <script type="module" src="${s}"></script>`).join("\n")}\n</body>`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bundlePage", () => {
  test("two scripts sharing a stateful module → module bundled ONCE, tag order preserved", () => {
    w("shared.js", `export let hits = 0; export const bump = () => { hits += 1; return "sentinel-shared-7f3"; };`);
    w("a.js", `import { bump } from "./shared.js"; console.log(bump() + "AAA-marker");`);
    w("b.js", `import { bump } from "./shared.js"; console.log(bump() + "BBB-marker");`);
    page("dedupe.html", "./a.js", "./b.js");

    const { code, bundleRel, html } = bundlePage(dir, "dedupe.html");
    expect(bundleRel).toBe("dedupe.bundle.js");
    expect(code.split("sentinel-shared-7f3").length - 1).toBe(1); // shared module emitted once
    expect(code.indexOf("AAA-marker")).toBeLessThan(code.indexOf("BBB-marker")); // tag order
    expect((html.match(/type="module"/g) ?? []).length).toBe(1);
    expect(html).toContain('src="./dedupe.bundle.js"');
  });

  test("a top-level-await module bundles", () => {
    w("tla.js", `const v = await Promise.resolve(42); export const V = v;`);
    page("tla.html", "./tla.js");
    const { code, bundleRel } = bundlePage(dir, "tla.html");
    expect(bundleRel).toBe("tla.bundle.js");
    expect(code).toContain("await");
  });

  test("no module scripts → bundleRel null, html unchanged", () => {
    const body = `<!doctype html><body><script src="./plain.js"></script></body>`;
    w("plain.html", body);
    const out = bundlePage(dir, "plain.html");
    expect(out.bundleRel).toBeNull();
    expect(out.code).toBe("");
    expect(out.html).toBe(body);
  });

  test("real public/overview.html → one overview.bundle.js entry, single module tag", () => {
    const publicDir = resolve(import.meta.dirname, "../public");
    const { bundleRel, html } = bundlePage(publicDir, "overview.html");
    expect(bundleRel).toBe("overview.bundle.js");
    expect((html.match(/type="module"/g) ?? []).length).toBe(1);
  });
});
