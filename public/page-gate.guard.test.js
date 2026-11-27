// The page gate's structural pins: every gated entry module's `// P11-gate` guard (a `canViewPage` line)
// precedes its first storage or IO site and sends a refused visitor to /overview; /overview itself never
// gates, never redirects and composes no gated-knob URLs; the /api/lab lookback is one shared constant.
// Public /api reads may start before the guard via prefetchThenGate (its URLs are not IO sites here).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const GATED = ["public/app.js", "public/lab.js", "public/exposure.js"];
const FIRST_IO = /\b(fetch|fetchOnce|getJson|request|send)\(|\breadBoot\(|\blocalStorage\b|\bsessionStorage\b/;
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
const codeLines = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !isComment(l));

for (const file of GATED) {
  describe(file, () => {
    const lines = readFileSync(file, "utf8").split("\n");
    const code = lines.map((l) => (isComment(l) || /^\s*import\b/.test(l) ? null : l));
    const firstIo = code.findIndex((l) => l !== null && FIRST_IO.test(l));
    const marker = lines.findIndex((l) => l.trim() === "// P11-gate" || l.trim().startsWith("// P11-gate "));

    it("has at least one IO site the regex sees (a drifted regex fails loud)", () => {
      expect(firstIo).toBeGreaterThan(-1);
    });
    it("carries the // P11-gate marker followed by a canViewPage gate line, before the first IO site", () => {
      expect(marker).toBeGreaterThan(-1);
      expect(lines[marker + 1]).toMatch(/\bcanViewPage\b/);
      expect(marker).toBeLessThan(firstIo);
    });
    it("redirects to /overview inside the guard", () => {
      expect(lines.slice(marker, marker + 4).join("\n")).toContain('location.replace("/overview")');
    });
  });
}

// /overview is the page a refused visitor is SENT TO: it never gates or redirects, and composes no
// gated-knob URLs (its fetch URLs live in load-cycle.js).
describe("public/overview.js", () => {
  const code = codeLines("public/overview.js");

  it("never gates or redirects - no canView(/canViewPage, no location.replace(", () => {
    expect(code.filter((l) => l.includes("canView(") || l.includes("canViewPage") || l.includes("location.replace("))).toEqual([]);
  });

  it("composes no gated-knob URLs - no mult=, no ?s=, no replay= (overview.js + load-cycle.js)", () => {
    for (const src of [code, codeLines("public/load-cycle.js")]) {
      expect(src.filter((l) => /[?&]mult=|\?s=|replay=/.test(l))).toEqual([]);
    }
  });

  it("shares the /api/lab lookback with lab.js - no literal hist=20, only LAB_LOOKBACK", () => {
    for (const f of ["public/overview.js", "public/load-cycle.js", "public/lab.js"]) {
      expect(codeLines(f).filter((l) => /hist=" \+ 20\b|hist=20\b/.test(l)), f).toEqual([]);
    }
    for (const f of ["public/load-cycle.js", "public/lab.js"]) {
      expect(codeLines(f).some((l) => /import \{[^}]*\bLAB_LOOKBACK\b[^}]*\} from "\.\/lab-lookback\.js"/.test(l)), f).toBe(true);
    }
  });
});
