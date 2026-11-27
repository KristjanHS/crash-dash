// The two legal literals are DUPLICATED across src/disclaimer.ts (the TS source) and
// public/disclaimer.js (the browser mirror) because the browser cannot import a .ts constant and
// tsconfig has no allowJs. This reads BOTH files as TEXT (not import — an import would read one
// evaluated value, not prove the two files agree) and fails on any byte divergence.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const TS_SRC = read("./disclaimer.ts");
const JS_SRC = read("../public/disclaimer.js");

// Each literal sits on one line as a single double-quoted string: `NAME = "…";`.
function literal(src: string, name: string): string {
  const m = src.match(new RegExp(`${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m || m[1] === undefined) throw new Error(`could not extract ${name} literal`);
  return m[1];
}

describe("disclaimer literals are byte-identical across the TS source and the JS mirror", () => {
  for (const name of ["DISCLAIMER_SHORT", "DISCLAIMER_LONG"]) {
    it(`${name} matches`, () => {
      const ts = literal(TS_SRC, name);
      const js = literal(JS_SRC, name);
      expect(js).toBe(ts);
    });
  }

  it("extraction is non-vacuous — the literals are the expected non-empty wording", () => {
    // Guards against a regex that silently captures "" on both sides (which would pass trivially).
    expect(literal(TS_SRC, "DISCLAIMER_SHORT")).toMatch(/^Not investment advice\./);
    expect(literal(TS_SRC, "DISCLAIMER_LONG").length).toBeGreaterThan(100);
  });
});
