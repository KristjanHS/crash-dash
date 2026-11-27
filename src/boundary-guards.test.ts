import { readFileSync } from "node:fs";
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { childProcessEnv, ENV_KEYS } from "./config.js";
import { expectClean, type Hit, loadTs, misfires, owner, scan, scanText, sourceFiles, type Visitor } from "./source-scan.test-helpers.js";

// Boundary guards: zero-row guards, each allow-list a named site.

let ts: typeof TS;
const callee = (n: TS.Node): string | null => (ts.isCallExpression(n) ? n.expression.getText() : null);

/** The allow-list is live: every named site still has a hit, so a moved entry cannot leave a dead exemption. */
const deadAllows = (hits: readonly Hit[], allows: readonly (readonly [string, string])[]): string[] =>
  allows.filter(([f, o]) => !hits.some((h) => h.file === f && (o === "*" || owner(h.node) === o))).map(([f, o]) => `${f} ${o}: no hit left`);
const allowed = (allows: readonly (readonly [string, string])[]) => (h: Hit): boolean =>
  !allows.some(([f, o]) => h.file === f && (o === "*" || owner(h.node) === o));

describe("boundary guards", () => {
  beforeAll(async () => {
    ts = await loadTs();
  });

  describe("raw fetch lives only in feed-http.ts and db-fetch.ts", () => {
    const GLOBAL_FETCH = /^(?:(?:globalThis|window|self)(?:\.fetch|\["fetch"\])|fetch)$/;
    const shadows = new WeakMap<TS.SourceFile, boolean>();
    /** The file binds its own `fetch` (`const fetch = …`, a param): a bare `fetch` there is the local, not the global. */
    const bindsFetch = (sf: TS.SourceFile): boolean => {
      if (!shadows.has(sf)) shadows.set(sf, /\b(?:const|let|var)\s+fetch\b|[(,]\s*fetch\s*[:,)=]/.test(sf.text));
      return shadows.get(sf)!;
    };
    /** A bare global `fetch` read as a value: not a declared name, a property name, a `typeof` operand or a local. */
    const isValueUse = (n: TS.Identifier): boolean => {
      const p = n.parent;
      if (bindsFetch(n.getSourceFile())) return false;
      if (ts.isShorthandPropertyAssignment(p)) return true;
      if ((p as { name?: TS.Node }).name === n || ts.isTypeQueryNode(p) || ts.isQualifiedName(p)) return false;
      return !(ts.isBindingElement(p) && p.propertyName === n);
    };
    const fetchV: Visitor = {
      visit: (n) => {
        const c = callee(n);
        if (c !== null && GLOBAL_FETCH.test(c)) return "call";
        const asCallee = n.parent !== undefined && ts.isCallExpression(n.parent) && n.parent.expression === n;
        if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && GLOBAL_FETCH.test(n.getText()) && n.getText() !== "fetch") return asCallee ? null : "alias";
        return ts.isIdentifier(n) && n.text === "fetch" && !asCallee && isValueUse(n) ? "alias" : null;
      },
    };
    const ALLOWS = [["src/feed-http.ts", "*"], ["src/db-fetch.ts", "*"]] as const;

    it("no raw fetch outside the two HTTP seams", () => {
      const r = scan({ ...fetchV, files: sourceFiles("src/"), keep: allowed(ALLOWS), roster: [], reasons: {} });
      expectClean(r, {
        what: "a raw `fetch` outside `feed-http.ts` / `db-fetch.ts`",
        why: "each raw fetch re-builds status check, retry and parse, and skips the run's fetch budget",
        move: "call `fetchText` / `fetchJson` from `feed-http.ts`",
        never: "wrap `fetch` in a local helper",
      });
      expect(deadAllows(scan({ ...fetchV, files: ALLOWS.map(([f]) => f), roster: [], reasons: {} }).hits, ALLOWS)).toEqual([]);
    });

    it("fires on a call and an alias, not on a method or a property name", () => {
      expect(misfires(fetchV, ["call", "alias"], [["await fetch(u);", "call"], ["const f = globalThis.fetch;", "alias"]], [
        "client.fetch(u);",
        "const o = { fetch: () => 1 };",
        "type F = typeof fetch;",
        "function f({ fetch: g }: O) {}",
      ])).toEqual([]);
      for (const src of ["const o = { fetchImpl: fetch };", "function f(g = fetch) {}", "const o = { fetch };", "const g = globalThis[\"fetch\"];", "window.fetch(u);"]) {
        expect(scanText("fixture.ts", src, fetchV).length, src).toBe(1);
      }
    });
  });

  describe("wall-clock reads only at entries; a clock is never a default", () => {
    const clockV: Visitor = {
      visit: (n) => {
        if (ts.isPropertyAccessExpression(n) && /^(?:globalThis\.)?Date\.now$/.test(n.getText())) return "now";
        if (ts.isNewExpression(n) && n.expression.getText() === "Date" && !n.arguments?.length) return "new-date";
        return ts.isIdentifier(n) && n.text === "wallClock" && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) ? "wall-clock" : null;
      },
    };
    const ALLOWS = [["src/run.ts", "*"], ["src/run-seeds.ts", "wallClock"], ["src/store-memory.ts", "dbServerNow"]] as const;

    it("no wall-clock read outside the three entry sites; only `run.ts` names `wallClock`", () => {
      const r = scan({ ...clockV, files: sourceFiles("src/"), keep: allowed(ALLOWS), roster: [], reasons: {} });
      expectClean(r, {
        what: "a wall-clock read or a defaulted clock below the entries",
        why: "an omitted `now`/`clock` silently reads the wall clock, so a test cannot pin it",
        move: "take `now: Date` or `clock: Clock` as a required param; the entry passes it",
        never: "default a clock param to `wallClock`, or add a new entry site",
      });
      expect(deadAllows(scan({ ...clockV, files: ALLOWS.map(([f]) => f), roster: [], reasons: {} }).hits, ALLOWS)).toEqual([]);
      expect(deadAllows(scanText("src/run-seeds.ts", "const other = () => Date.now();", clockV), [["src/run-seeds.ts", "wallClock"]])).toEqual([
        "src/run-seeds.ts wallClock: no hit left",
      ]);
    });

    it("fires on each arm, not on a dated Date or performance.now", () => {
      expect(misfires(clockV, ["now", "new-date", "wall-clock"], [
        ["const t = Date.now();", "now"],
        ["const n = globalThis.Date.now;", "now"],
        ["const d = new Date();", "new-date"],
        ["function f(clock: Clock = wallClock) {}", "wall-clock"],
        ["const c = opts.clock ?? wallClock;", "wall-clock"],
      ], ["const d = new Date(\"2026-01-01\");", "const t = performance.now();", "const wallClock: Clock = () => iso;"])).toEqual([]);
    });
  });

  describe("env names are one set, read in one place", () => {
    const envV: Visitor = {
      visit: (n) => (ts.isPropertyAccessExpression(n) && n.getText() === "process.env" ? "env" : null),
    };

    it("`ENV_KEYS` ≡ the `.env.example` keys", () => {
      const example = [...readFileSync(".env.example", "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
      expect([...example].sort()).toEqual([...ENV_KEYS].sort());
    });

    it("`process.env` is read only in `src/config.ts`", () => {
      const r = scan({ ...envV, files: sourceFiles("src/", "api/"), keep: (h) => h.file !== "src/config.ts", roster: [], reasons: {} });
      expectClean(r, {
        what: "a `process.env` read outside `src/config.ts`",
        why: "env must enter as an `Env` param, or a test cannot set it without re-isolating the file",
        move: "add the name to `ENV_KEYS` + `.env.example`, take `env: Env` as a param",
        never: "read `process.env` below an entry",
      });
      expect(scan({ ...envV, files: ["src/config.ts"], roster: [], reasons: {} }).hits.length).toBeGreaterThan(0);
    });

    it("fires on any use of `process.env`, not on a local `env`", () => {
      for (const src of ["const a = process.env.FOO;", "const a = process.env[k];", "const { A } = process.env;", "function f(env = process.env) {}"]) {
        expect(misfires(envV, ["env"], [[src, "env"]], ["const b = env.FOO;"]), src).toEqual([]);
      }
    });
  });

  describe("`childProcessEnv` is child-process plumbing, imported only by `src/prod-writes.ts`", () => {
    const childEnvV: Visitor = {
      visit: (n) => (ts.isIdentifier(n) && n.text === "childProcessEnv" && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n) ? "use" : null),
    };
    const ALLOWS = [["src/prod-writes.ts", "*"]] as const;

    it("no `childProcessEnv` use outside the roster", () => {
      const r = scan({ ...childEnvV, files: sourceFiles("src/", "api/", "scripts/"), keep: allowed(ALLOWS), roster: [], reasons: {} });
      expectClean(r, {
        what: "a `childProcessEnv` use outside its roster",
        why: "it reads `process.env` past the `ENV_KEYS` seam — a second door to the inherited environment",
        move: "read config via `readEnv()`; a new child-process caller is a reviewed roster row here",
        never: "read config off a child-process env",
      });
      expect(deadAllows(scan({ ...childEnvV, files: ALLOWS.map(([f]) => f), roster: [], reasons: {} }).hits, ALLOWS)).toEqual([]);
    });

    it("fires on an import, a call and a member read, not on its declaration or a string", () => {
      expect(misfires(childEnvV, ["use"], [
        ["import { childProcessEnv } from \"./config.js\";", "use"],
        ["const e = config.childProcessEnv(new Set());", "use"],
        ["export { childProcessEnv } from \"./config.js\";", "use"],
      ], ["export function childProcessEnv() {}", "const s = \"childProcessEnv\";"])).toEqual([]);
    });

    it("drops every `ENV_KEYS` key and the `omit` keys, keeps the rest", () => {
      const inherited = { ...Object.fromEntries(ENV_KEYS.map((k) => [k, "x"])), GIT_DIR: "x", PATH: "/bin" };
      expect(childProcessEnv(new Set(["GIT_DIR"]), inherited)).toEqual({ PATH: "/bin" });
    });
  });

  describe("feed modules parse HTTP bodies only through feed-http.ts", () => {
    const parseV: Visitor = {
      visit: (n) => {
        const c = callee(n);
        if (c === "JSON.parse") return "parse";
        return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "json" && n.arguments.length === 0 ? "json" : null;
      },
    };
    const importsFeedHttp = (f: string): boolean => /from "(?:\.\.?\/)+feed-http\.js"/.test(readFileSync(f, "utf8"));

    it("no `.json()` / `JSON.parse` in a `feed-http.ts` importer", () => {
      const feeds = sourceFiles("src/").filter((f) => f !== "src/feed-http.ts" && importsFeedHttp(f));
      expect(feeds).toContain("src/fred.ts");
      expectClean(scan({ ...parseV, files: feeds, roster: [], reasons: {} }), {
        what: "a feed module parsing an HTTP body itself",
        why: "a hand-rolled parse skips `badJson`'s per-feed message and lets an `as T` cast through",
        move: "`fetchJson(url, parse)` with a hand parser",
        never: "cast `.json()` to the feed's type",
      });
    });

    it("fires on both arms, not on `JSON.stringify` or a `.json(x)` call", () => {
      expect(misfires(parseV, ["parse", "json"], [["const o = JSON.parse(t);", "parse"], ["const o = await res.json();", "json"]], [
        "const s = JSON.stringify(o);",
        "res.json(body);",
      ])).toEqual([]);
    });
  });
});
