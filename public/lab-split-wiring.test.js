/**
 * `lab.js` and its split siblings are unbundled browser ESM outside `tsc`, and all four execute
 * module-level DOM side effects, so nothing imports them — a call to a sibling's function that was
 * never exported/imported is a prod-only `ReferenceError` no suite and no `node --check` can see.
 * (It shipped: `feedLagFoot` stayed private in `lab-board.js` while `lab.js` kept calling it →
 * "Could not load the panel: feedLagFoot is not defined".) This resolves every cross-file call site.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Strip comments first: the prose in these files names the symbols it describes, and a raw-text
 *  match would read a MENTION as a call (the `coverage-marks.test.js` comment-stripping rule). */
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Drop string/template TEXT while keeping `${…}` interpolations, which hold real call sites: the
 *  markup these files emit prints symbol names as prose (`<p>mode (danger×growth)`) and a raw match
 *  reads that as a call. Same reason as `decomment` above, one layer down. */
function codeOnly(src) {
  const stack = [];
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && (quote || stack.at(-1) === "`")) i++;
    else if (quote) quote = c === quote ? null : quote;
    else if (stack.at(-1) === "`") {
      if (c === "`") stack.pop();
      else if (c === "$" && src[i + 1] === "{") (stack.push("}"), i++, (out += " "));
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "`") stack.push("`");
    else if (c === "{" && stack.length) (stack.push("{"), (out += c));
    else if (c === "}" && stack.length) (stack.pop(), (out += " "));
    else out += c;
  }
  return out;
}

const FILES = ["lab.js", "lab-board.js", "lab-reader.js", "lab-chips.js"];
/** `RAW` keeps the strings the import specifiers live in; `SRC` is the code-only view everything
 *  else scans. Parsing imports off `SRC` finds none — `codeOnly` empties `from "./x.js"`. */
const RAW = Object.fromEntries(FILES.map((f) => [f, decomment(readFileSync(here(`./${f}`), "utf8"))]));
const SRC = Object.fromEntries(FILES.map((f) => [f, codeOnly(RAW[f])]));

/** Top-level bindings, keyed by whether `export` fronts them — column 0 is the top-level marker. */
function declared(src) {
  const all = new Set();
  const exported = new Set();
  for (const m of src.matchAll(/^(export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/gm)) {
    all.add(m[2]);
    if (m[1]) exported.add(m[2]);
  }
  return { all, exported };
}

/** Named imports as `{ local, source }` rows — `as` aliases keep the LOCAL name (what the body
 *  calls) beside the SOURCE name (what the target must export). */
function imported(src) {
  const rows = [];
  for (const m of src.matchAll(/import\s*(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|([\w$]+))\s*from\s*"([^"]+)"/g)) {
    for (const part of (m[1] || "").split(",").filter((p) => p.trim())) {
      const [source, local = source] = part.trim().split(/\s+as\s+/);
      rows.push({ local, source, from: m[4] });
    }
    for (const whole of [m[2], m[3]]) if (whole) rows.push({ local: whole, source: "*", from: m[4] });
  }
  return rows;
}

const DECL = Object.fromEntries(FILES.map((f) => [f, declared(SRC[f])]));
const IMP = Object.fromEntries(FILES.map((f) => [f, imported(RAW[f])]));

/** Call sites in `file` naming a top-level binding of some OTHER split file, split by whether the
 *  caller can actually see it (own declaration or import) — the unresolved half is the defect. */
function crossFileCalls(file) {
  const resolved = [];
  const unresolved = [];
  const visible = new Set([...DECL[file].all, ...IMP[file].map((r) => r.local)]);
  for (const other of FILES) {
    if (other === file) continue;
    for (const name of DECL[other].all) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(SRC[file])) continue;
      (visible.has(name) ? resolved : unresolved).push(`${file} → ${other}.${name}`);
    }
  }
  return { resolved, unresolved };
}

describe("lab split wiring - every cross-file call resolves to an export the caller imports", () => {
  for (const file of FILES)
    it(`${file} calls nothing it cannot see`, () => {
      expect(crossFileCalls(file).unresolved).toEqual([]);
    });

  for (const file of FILES)
    it(`${file} imports only names its sibling really exports`, () => {
      // The mirror defect: the call resolves to an import, but the import itself throws at load
      // ("does not provide an export named X") — a whole-page break, not a missing panel.
      const missing = IMP[file]
        .filter((r) => FILES.includes(r.from.replace("./", "")) && !DECL[r.from.replace("./", "")].exported.has(r.source))
        .map((r) => `${file} ← ${r.from} does not export ${r.source}`);
      expect(missing).toEqual([]);
    });

  it("the walker really resolves calls (a parse that finds none would pass the above vacuously)", () => {
    // Anchored on the RESOLVED column, not the unresolved one it exists to drain.
    expect(crossFileCalls("lab.js").resolved).toContain("lab.js → lab-board.js.renderDangerField");
    expect(DECL["lab-board.js"].all.size).toBeGreaterThan(DECL["lab-board.js"].exported.size);
    expect(IMP["lab.js"].filter((r) => r.from === "./lab-board.js").length).toBeGreaterThan(10);
  });
});
