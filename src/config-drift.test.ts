import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Naming-guard for the SUPABASE service key (6.2, Deploy-A4 remainder). The app reads
 * `SUPABASE_SERVICE_KEY` — the manually-set Vercel-prod var — NOT the `_ROLE_`-suffixed
 * variant the Supabase↔Vercel integration injects (config.ts `ENV_KEYS` pins this as a "NOT a typo"
 * comment). A stray `SUPABASE_SERVICE_ROLE_KEY` anywhere in the code would silently read
 * the wrong (or unset) var. This asserts that comment-only invariant as a real check.
 *
 * Scans every non-test `src/**` + `api/**` TS source (test files excluded so the guard can
 * name the forbidden strings without matching itself).
 */

const sources = [...globSync("src/**/*.ts"), ...globSync("api/**/*.ts")]
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

// A line is a comment if its trimmed form opens with `//`, `*`, or `/*` — enough to tell the
// config.ts documentation lines from live code (this repo has no `_ROLE_` inside string literals).
const isCommentLine = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe("SUPABASE service-key naming guard", () => {
  it("scans a non-empty set of sources (glob sanity)", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("only mentions `_ROLE_` in the config.ts 'NOT a typo' comment (comment-only, no code)", () => {
    for (const { file, text } of sources) {
      const roleLines = text.split("\n").filter((l) => l.includes("_ROLE_"));
      if (roleLines.length === 0) continue;
      // The single sanctioned home is the `ENV_KEYS` documentation block — config.ts is the one env read.
      expect(file, `_ROLE_ appears outside src/config.ts (in ${file})`).toBe("src/config.ts");
      for (const line of roleLines) {
        expect(isCommentLine(line), `_ROLE_ appears in NON-comment code: ${line.trim()}`).toBe(true);
      }
    }
  });
});
