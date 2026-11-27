/** No test pins a constant's VALUE (`testing-project.md`; a retired plan).
 *  Derive the fixture from the symbol, or guard its premise (`> 0`, `<` another knob). */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const ROOTS = ["src", "scripts", "api", "public"];
const SELF = "scripts/const-pin-lint.test.ts";
const NUM = /^(toBe|toEqual|toBeCloseTo|toStrictEqual|toHaveLength)\(\s*-?[0-9.]+/;
/** A string, a boolean/null, an empty or literal-led array, an empty object or one with any literal value */
const LIT = new RegExp(String.raw`^(toBe|toEqual|toStrictEqual|toMatchObject)\(\s*((["'${"`"}]|(true|false|null)\s*\)|\[\s*(["'${"`"}]|-?\.?[0-9]|\])|\{\s*\}|\{[^}]*:\s*(["'${"`"}]|-?\.?[0-9]|\[\s*(["'${"`"}]|-?\.?[0-9]|\])|true\b|false\b|null\b)))`);
/** Array-shaping links a projection chain may use; any other call (`.has`, `.every`) is a property, not a pin. */
const SHAPING = new Set(["map", "filter", "flatMap", "flat", "find", "sort", "slice", "reverse", "join"]);
const LOOKUP: Record<string, RegExp> = { at: /^-?\d+$/, get: /^(["'`][^"'`$]*["'`]|-?\d+)$/ };
const ARROW = /^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const CALLEE = /(^|[^.\w$])([A-Za-z_$][\w$]*)(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*\s*\(/g;
const REGEX_PREV = /[(,=:[!&|?{};>\n]/;

/** End of the string, comment or regex literal opening at `i` (`prev` = last significant char); -1 if none opens there. */
function skip(s: string, i: number, prev: string): number {
  const c = s[i];
  if (c === '"' || c === "'" || c === "`") {
    for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
    return i;
  }
  if (c !== "/") return -1;
  if (s[i + 1] === "/") return s.indexOf("\n", i) < 0 ? s.length : s.indexOf("\n", i) - 1;
  if (s[i + 1] === "*") return s.indexOf("*/", i + 2) < 0 ? s.length : s.indexOf("*/", i + 2) + 1;
  if (!REGEX_PREV.test(prev)) return -1;
  for (i++; i < s.length && s[i] !== "/" && s[i] !== "\n"; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") for (i++; i < s.length && s[i] !== "]"; i++) if (s[i] === "\\") i++;
  }
  return i;
}

/** Index of the bracket closing the one at `open`, skipping strings, comments and regex literals; -1 if none within reach. */
function close(s: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let prev = "\n";
  for (let i = open; i < s.length && i < open + 4000; i++) {
    const c = s[i]!;
    const end = skip(s, i, prev);
    if (end >= 0) {
      i = end;
      prev = c === "/" && (s[i] === "\n" || s[i - 1] === "*") ? prev : "a";
      continue;
    }
    const shut = pair[c];
    if (shut) stack.push(shut);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
    if (c === "\n") prev = "\n";
    else if (!/\s/.test(c)) prev = c === "!" && /[\w$)\]]/.test(prev) ? "a" : c;
  }
  return -1;
}

/** Cut at the first depth-0 comma (`expect(x, "msg")`). */
function firstArg(s: string): string {
  for (let i = 0, depth = 0, prev = "("; i < s.length; i++) {
    const c = s[i]!;
    const end = skip(s, i, prev);
    if (end >= 0) {
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return s.slice(0, i);
    if (!/\s/.test(c)) prev = c === "!" && /[\w$)\]]/.test(prev) ? "a" : c;
  }
  return s;
}

/** Names the file imports (named, aliased, default, namespace). */
function importedNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const [, clause] of src.matchAll(/\bimport\s+([\w$\s,{}*]+?)\s+from\s*["']/g)) {
    const braces = /\{([^}]*)\}/.exec(clause!)?.[1] ?? "";
    for (const item of braces.split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (name) out.add(name);
    }
    const rest = clause!.replace(/\{[^}]*\}/, "");
    const ns = /\*\s*as\s+([\w$]+)/.exec(rest)?.[1];
    if (ns) out.add(ns);
    const def = /^\s*(?!type\b)([A-Za-z_$][\w$]*)/.exec(rest)?.[1];
    if (def) out.add(def);
  }
  return out;
}

/** An inline arrow is a projection unless its body calls an imported function (behavior over the roster). */
function projection(arg: string, imports: Set<string>): boolean {
  const head = ARROW.exec(arg);
  return !!head && ![...arg.slice(head[0].length).matchAll(CALLEE)].some((m) => imports.has(m[2]!));
}

/** `.member`, `!`, `?.`, `[literal]`, `.at/.get(literal)`, `.sort()`, `.map(projection)` links only — an imported-function arg ends the match. */
function projectionChain(rest: string, imports: Set<string>): boolean {
  for (let i = 0; i < rest.length; ) {
    if (rest[i] === "!" && rest[i + 1] !== "=") {
      i++;
      continue;
    }
    if (rest.startsWith("?.", i)) i += rest[i + 2] === "[" ? 2 : 1;
    const m = /^\.([A-Za-z_$][\w$]*)/.exec(rest.slice(i));
    if (m) {
      i += m[0].length;
      if (rest[i] !== "(") continue;
      const end = close(rest, i);
      const arg = end < 0 ? null : rest.slice(i + 1, end).trim();
      if (arg === null) return false;
      const lookup = LOOKUP[m[1]!];
      if (lookup ? !lookup.test(arg) : !SHAPING.has(m[1]!)) return false;
      if (!lookup && arg !== "" && !projection(arg, imports) && !(/^[A-Za-z_$][\w$]*$/.test(arg) && !imports.has(arg))) return false;
      i = end + 1;
    } else if (rest[i] === "[") {
      const end = close(rest, i);
      if (end < 0 || !/^\s*(["'`][^"'`]*["'`]|-?\d+)\s*$/.test(rest.slice(i + 1, end))) return false; // a runtime key is a lookup relation
      i = end + 1;
    } else return false;
  }
  return true;
}

/** The LHS reads a constant: `C…`, `ns.C…` (namespace import), `[...C…]…`, `Object.keys(C…)…`. */
function readsConstant(lhs: string, namespaces: Set<string>, imports: Set<string>): boolean {
  const s = lhs.trim();
  const recv = (t: string) => {
    const m = /^(?:([a-z_$][\w$]*)\.)?[A-Z][A-Z0-9_]+(?![\w$])/.exec(t);
    return m && (!m[1] || namespaces.has(m[1])) ? m[0].length : 0;
  };
  const wrapped = /^(\[\s*\.\.\.|Object\.(keys|values|entries)\()/.exec(s);
  if (wrapped) {
    const end = close(s, wrapped[0].startsWith("[") ? 0 : wrapped[0].length - 1);
    const inner = s.slice(wrapped[0].length, end).trim();
    const n = recv(inner);
    return end > 0 && n > 0 && projectionChain(inner.slice(n), imports) && projectionChain(s.slice(end + 1), imports);
  }
  const n = recv(s);
  return n > 0 && projectionChain(s.slice(n), imports);
}

type Expect = { line: number; lhs: string; rhs: string | null; constLhs: boolean };

/** Every `expect(…).matcher(…)` statement; `rhs: null` = the matcher's argument list did not parse. */
function scan(src: string): Expect[] {
  const namespaces = new Set([...src.matchAll(/import\s*\*\s*as\s+([\w$]+)/g)].map((m) => m[1]!));
  const imports = importedNames(src);
  const code = src.split("\n").map((l) => (isComment(l) ? "" : l)).join("\n");
  const out: Expect[] = [];
  for (let i = code.indexOf("expect("); i >= 0; i = code.indexOf("expect(", i + 7)) {
    if (i > 0 && /[\w$.]/.test(code[i - 1]!)) continue;
    const line = code.slice(0, i).split("\n").length;
    const lEnd = close(code, i + 6);
    if (lEnd < 0) {
      out.push({ line, lhs: code.slice(i + 7, i + 90), rhs: null, constLhs: true });
      continue;
    }
    const lhs = firstArg(code.slice(i + 7, lEnd));
    const constLhs = readsConstant(lhs, namespaces, imports);
    const m = /^\s*\.\s*([A-Za-z]+)\s*\(/.exec(code.slice(lEnd + 1, lEnd + 200));
    if (!m) continue;
    const open = lEnd + m[0].length;
    const rEnd = close(code, open);
    const rhs = rEnd < 0 ? null : `${m[1]}(${code.slice(open + 1, rEnd)})`.replace(/\s+/g, " ");
    out.push({ line, lhs, rhs, constLhs });
  }
  return out;
}

function pins(src: string): string[] {
  const out: string[] = [];
  for (const { line, lhs, rhs, constLhs } of scan(src)) {
    if (!constLhs) continue;
    const shown = lhs.replace(/\s+/g, " ").trim();
    if (rhs === null) {
      out.push(`${line}: unparsed expect(${shown}`);
      continue;
    }
    const offenders = /^(\w+\(\s*(\[\s*\]|\{\s*\})|toHaveLength\(\s*0)\s*\)$/.test(rhs) && /\.(filter|find)\(/.test(lhs); // "none offend" relation
    const template = /^\w+\(\s*`[^`]*\$\{/.test(rhs);
    if (!offenders && !template && (NUM.test(rhs) || LIT.test(rhs))) out.push(`${line}: expect(${shown}).${rhs}`);
  }
  return out;
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.(ts|js)$/.test(e.name)) out.push(path.relative(REPO, p).split(path.sep).join("/"));
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
/** One fixture per line; returns the fixtures that fired. */
const fired = (lines: string[], head = "") =>
  pins([head, ...lines].join("\n")).map((h) => lines[Number(h.split(":")[0]) - 2]);

describe("constant-value pin lint", () => {
  const files = ROOTS.flatMap((r) => testFiles(path.join(REPO, r))).filter((f) => f !== SELF);

  test("the matcher reds on a planted pin and passes its derived and premise forms", () => {
    const pinned = ["    expect(X_N).toBe(3);", "    expect(mod.X_N).toEqual(0.5);"];
    expect(fired(pinned, `import * as mod from "./m.js";`)).toEqual(pinned);
    expect(fired(["    expect(X_N).toBeGreaterThan(0);", "    expect(f(X_N)).toBe(3);", "    // expect(X_N).toBe(3)"])).toEqual([]);
  });

  test("literal string/array/object pins red; symbol-built (parity) RHS passes", () => {
    const literal = [
      `expect(X_N).toBe("2026-08-07");`,
      `expect(X_N).toBe('a');`,
      "expect(X_N).toBe(`a`);",
      `expect(X_N).toEqual(["a", "b"]);`,
      `expect(X_N).toEqual([1, 2]);`,
      `expect(mod.X_N).toStrictEqual({ a: 1, b: 2 });`,
      `expect(X_N).toEqual({ "EARLY-WARN": ["cr"] });`,
      `expect(X_N).toEqual({ amber: Y_N.amber, red: 0.4 });`,
      `expect(X_N).toEqual({ on: true });`,
      `expect(X_N).toEqual({ ...Y_N, h: 170 });`,
      `expect(X_N).toEqual([]);`,
      `expect(X_N).toEqual({});`,
      `expect(X_N.on).toBe(true);`,
    ];
    expect(fired(literal, `import * as mod from "./m.js";`)).toEqual(literal);
    const parity = [
      `expect(X_N).toEqual([...Y_N]);`,
      `expect(X_N).toEqual({ amber: Y_N.amber, red: Y_N.red });`,
      `expect(X_N).toEqual({ a, b });`,
      `expect(X_N.every((d) => d.on)).toBe(true);`,
      `expect(X_N).not.toBe("a");`,
      `expect(x).toBe("a");`,
    ];
    expect(fired(parity)).toEqual([]);
  });

  test("member, spread, key-list, length and projection forms red; a named-function filter passes", () => {
    const disguised = [
      `expect(X_N.monthly).toBe(40);`,
      `expect(X_N["Cache-Control"]).toBe("s-maxage=60");`,
      `expect([...X_N]).toEqual([0, 1, 2]);`,
      `expect(X_N.size).toBe(0);`,
      `expect(Object.keys(X_N).sort()).toEqual(["a"]);`,
      `expect(X_N.map((c) => c.id)).toEqual(["a"]);`,
      `expect(X_N.filter((d) => d.t === "T1" && !d.gate)).toHaveLength(6);`,
      `expect(X_N).toHaveLength(3);`,
      `expect(mod.X_N.a, "msg").toBe(1);`,
    ];
    expect(fired(disguised, `import * as mod from "./m.js";`)).toEqual(disguised);
    expect(pins("expect(\n  X_N.map((c) => c.id),\n).toEqual([\n  \"a\",\n]);")).toEqual([`1: expect(X_N.map((c) => c.id)).toEqual([ "a", ])`]);
    const behavior = [
      `expect(X_N.filter(isVel)).toEqual(["a"]);`,
      `expect(X_N.filter((l) => !isVel(l))).toEqual(["a"]);`,
      `expect(byId.F1.axis).toBe("velocity");`,
      `expect(X_N.size).toBeGreaterThan(0);`,
      `expect(X_N.has("V")).toBe(false);`,
      `expect(X_N.filter((k) => !Y_N.has(k))).toEqual([]);`,
      `expect(X_N[entry.id]).toBe("a");`,
    ];
    expect(fired(behavior, `import { isVel } from "./m.js";`)).toEqual([]);
  });

  test("member-spread, non-null, optional, literal at/get, toMatchObject and non-imported callee forms red", () => {
    const disguised = [
      `expect([...X_N.ids]).toEqual(["a"]);`,
      `expect(Object.keys(X_N.ids)).toEqual(["a"]);`,
      `expect(X_N.x!).toBe(3);`,
      `expect(X_N?.x).toBe(3);`,
      `expect(X_N.find((d) => d.k === "a")!.w).toBe(3);`,
      `expect(X_N.at(-1)).toBe(3);`,
      `expect(M_P.get("k")).toBe(3);`,
      `expect(X_N).toMatchObject({ a: 1 });`,
      `expect(X_N.filter(local)).toEqual(["a"]);`,
      `expect(X_N.filter(isVel)).toEqual(["a"]);`,
      `expect(X_N.map(String)).toEqual(["a"]);`,
      `expect(X_N.map((c) => String(c))).toEqual(["a"]);`,
    ];
    expect(fired(disguised, `import { isVel as iv } from "./m.js";`)).toEqual(disguised);
    const silent = [
      `expect(X_N.filter(iv)).toEqual(["a"]);`,
      `expect(X_N.map((c) => iv(c))).toEqual(["a"]);`,
      `expect(M_P.get(key)).toBe(3);`,
      `expect(X_N.at(i)).toBe(3);`,
      `expect(X_N).toEqual({ a: [Y_N, "b"] });`,
      "expect(X_N.x).toBe(`a${y}`);",
      `expect(X_N.filter((c) => c.on)).toHaveLength(0);`,
      `expect(X_N.x).toEqual(Y_N.x.replace(/[(]/g, ""));`,
      `expect(X_N.x).toMatch(/s-maxage=\\d+/);`,
    ];
    expect(fired(silent, `import { isVel as iv } from "./m.js";`)).toEqual([]);
    expect(pins("expect(\n  X_N.x, // it's\n).toBeGreaterThan(0);")).toEqual([]);
    expect(pins("expect(X_N.x).toBe((3);")).toEqual(["1: unparsed expect(X_N.x"]);
  });

  test("no test file asserts a constant's literal value", () => {
    expect(files).toContain("src/families.test.ts"); // walker reached the tree
    const guard = scan(readFileSync(path.join(REPO, "src/danger-ladder.test.ts"), "utf8")).find((e) => e.lhs.trim() === "LEG_FIELD.length");
    expect(guard).toMatchObject({ constLhs: true, rhs: "toBeGreaterThan(0)" });
    const hits = files.flatMap((f) => pins(readFileSync(path.join(REPO, f), "utf8")).map((h) => `${f}:${h}`));
    expect(hits).toEqual([]);
  });
});
