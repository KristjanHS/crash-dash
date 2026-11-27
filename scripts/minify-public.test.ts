import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "minify-public-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("minify-public (ship-time, on a copy)", () => {
  cpSync(join(repo, "public"), join(dir, "public"), { recursive: true });
  const css = readdirSync(join(dir, "public")).filter((n) => n.endsWith(".css"));
  const tests = readdirSync(join(dir, "public")).filter((n) => n.endsWith(".test.js"));
  const before = new Map([...css, ...tests].map((n) => [n, readFileSync(join(dir, "public", n), "utf8")]));
  execFileSync(join(repo, "node_modules/.bin/tsx"), [join(repo, "scripts/minify-public.ts"), dir], { stdio: "pipe" });

  it("every public/*.css shrinks and keeps every class selector", () => {
    expect(css.length).toBeGreaterThan(3);
    for (const n of css) {
      const out = readFileSync(join(dir, "public", n), "utf8");
      expect(statSync(join(dir, "public", n)).size, n).toBeLessThan(before.get(n)!.length * 0.9);
      const classes = (s: string) => new Set(s.replace(/\/\*[\s\S]*?\*\//g, "").match(/\.-?[_a-zA-Z][\w-]*(?=[^}]*\{)/g));
      expect(classes(before.get(n)!).size, n).toBeGreaterThan(0);
      expect(classes(out), n).toEqual(classes(before.get(n)!));
    }
  });

  it("leaves *.test.js untouched", () => {
    for (const n of tests) expect(readFileSync(join(dir, "public", n), "utf8"), n).toBe(before.get(n));
  });
});
