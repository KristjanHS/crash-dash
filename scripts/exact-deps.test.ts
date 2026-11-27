/** Every direct dep is an exact version and `.npmrc` keeps `save-exact=true` (`overrides` stay ranges — transitive security floors). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function rangedDeps(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries((pkg[key] ?? {}) as Record<string, string>)) {
      if (!EXACT.test(spec)) out.push(`${key}.${name}: ${spec}`);
    }
  }
  return out;
}

describe("direct deps are pinned exactly", () => {
  it("package.json carries no range", () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as Record<string, unknown>;
    // Vacuity anchor: the scan reads the real devDependencies block, not an empty one.
    expect(Object.keys((pkg.devDependencies ?? {}) as Record<string, string>)).toContain("vitest");
    expect(rangedDeps(pkg), "pin to the package-lock.json version").toEqual([]);
  });

  it(".npmrc sets save-exact=true", () => {
    expect(readFileSync(`${ROOT}.npmrc`, "utf8")).toMatch(/^save-exact=true$/m);
  });

  it("the scan flags caret, tilde, major-only and star specs", () => {
    const pkg = { dependencies: { a: "^1.2.3", b: "1.2.3" }, devDependencies: { c: "~2.0.0", d: "5", e: "*" } };
    expect(rangedDeps(pkg)).toEqual(["dependencies.a: ^1.2.3", "devDependencies.c: ~2.0.0", "devDependencies.d: 5", "devDependencies.e: *"]);
  });
});
