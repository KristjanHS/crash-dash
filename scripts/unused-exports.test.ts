// knip over src+api: default arm (entry exports included) = no unused export outside ROSTER;
// --production arm = ratchet on scripts/knip-prod-baseline.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { expectClean, type FailMessage, type Row, type ScanReport } from "../src/source-scan.test-helpers.js";

const KINDS = ["files", "exports", "types", "enumMembers", "namespaceMembers"] as const;
const BASELINE = "scripts/knip-prod-baseline.json";
/** The gate's scope: scripts/ are entries only, never gated. */
const IN_SCOPE = /^(src|api)\//;
/** Exports the Vercel runtime calls by name: nothing in the repo imports them. */
const HANDLER_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "default", "config"]);

interface KnipHit { file: string; kind: string; name: string }
type KnipIssue = { file: string } & Partial<Record<(typeof KINDS)[number], { name: string }[]>>;

function knip(cwd: string, ...args: string[]): KnipHit[] {
  const r = spawnSync(join(process.cwd(), "node_modules/.bin/knip"), ["--reporter", "json", "--no-progress", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`knip exited ${r.status}: ${r.stderr}`);
  const { issues } = JSON.parse(r.stdout) as { issues: KnipIssue[] };
  return issues.flatMap((i) => KINDS.flatMap((kind) => (i[kind] ?? []).map((e) => ({ file: i.file, kind, name: e.name }))));
}
const label = (h: KnipHit): string => `${h.file} [${h.kind}] ${h.name}`;
const key = (file: string, name: string): string => `${file}\0${name}`;

/** A roster row's reason is `<kind>: <text>`; `parity:` names the test that reads the symbol as source text,
 *  `handler:` is a Vercel route export of a file under api/. */
const REASONS: Readonly<Record<string, (r: Row) => string | null>> = {
  parity: (r) => {
    const test = /\S+\.test\.ts/.exec(r.reason)?.[0];
    return test && existsSync(test) && readFileSync(test, "utf8").includes(`"${r.code}"`) ? null : `no named *.test.ts reads "${r.code}"`;
  },
  handler: (r) => (r.file.startsWith("api/") && HANDLER_EXPORTS.has(r.code) ? null : `not a route export of an api/ file`),
};

const ROSTER: readonly Row[] = [
  { file: "src/disclaimer.ts", code: "DISCLAIMER_LONG", count: 1, reason: "parity: src/disclaimer-parity.test.ts reads the literal from source text" },
  { file: "api/exposure.ts", code: "GET", count: 1, reason: "handler: Vercel route, no test imports it" },
  { file: "api/replay.ts", code: "GET", count: 1, reason: "handler: Vercel route, no test imports it" },
  { file: "api/cron/run.ts", code: "GET", count: 1, reason: "handler: Vercel cron route, no test imports it" },
];

function rosterReport(hits: readonly KnipHit[], roster: readonly Row[]): ScanReport {
  const rostered = new Set(roster.map((r) => key(r.file, r.code)));
  const unrostered = hits.filter((h) => !rostered.has(key(h.file, h.name))).map(label);
  const stale: string[] = [];
  const badReason: string[] = [];
  for (const r of roster) {
    const found = hits.filter((h) => key(h.file, h.name) === key(r.file, r.code)).length;
    if (found !== r.count) stale.push(`${r.file}: pinned ${r.count}×, found ${found}× - ${r.code}`);
    const kind = /^(\S+?): \S/.exec(r.reason)?.[1];
    const check = kind === undefined ? undefined : REASONS[kind];
    const wrong = check ? check(r) : `reason kind ${JSON.stringify(kind ?? r.reason)} ∉ {${Object.keys(REASONS).join(", ")}}`;
    if (wrong !== null) badReason.push(`${r.file}: ${wrong} - ${r.code}`);
  }
  return { hits: [], unrostered, stale, badReason };
}

function baselineReport(hits: readonly KnipHit[], baseline: readonly string[]): ScanReport {
  const got = new Set(hits.map(label));
  const want = new Set(baseline);
  return { hits: [], unrostered: [...got].filter((h) => !want.has(h)).sort(), stale: [...want].filter((h) => !got.has(h)).map((h) => `${BASELINE}: delete row - ${h}`), badReason: [] };
}

const DEFAULT_MSG: FailMessage = {
  what: "export nothing imports (knip)",
  why: "a dead export reads as a live seam",
  move: "delete it, or drop `export` if only this file uses it",
  never: "add a re-export to silence this",
};
const PROD_MSG: FailMessage = {
  what: "export only tests or one-off scripts import (knip --production)",
  why: "a test-only export widens the module surface for a test's convenience",
  move: `test through the module's public seam and drop \`export\`, or add the row to \`${BASELINE}\` for a deliberate test seam`,
  never: "add a re-export, or move the symbol into a *.test-helpers.ts to silence this",
};

describe("unused exports (knip)", () => {
  // knip runs in beforeAll: the spawns are fixture work, outside TEST_CEILING_MS.
  let fixture: KnipHit[] = [];
  let repo: KnipHit[] = [];
  let prod: KnipHit[] = [];
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "knip-fx-"));
    try {
      writeFileSync(join(dir, "package.json"), '{ "name": "fx", "type": "module" }');
      writeFileSync(join(dir, "knip.json"), '{ "entry": ["src/index.ts", "scripts/tool.ts"], "project": ["**/*.ts"] }');
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "src/index.ts"), 'import { used } from "./lib.js";\nconsole.log(used);\nexport const entryDead = 3;\n');
      writeFileSync(join(dir, "src/lib.ts"), "export const used = 1;\nexport const dead = 2;\nexport type Dead = number;\n");
      writeFileSync(join(dir, "scripts/tool.ts"), 'export { dead } from "../src/lib.js";\nexport const toolDead = 4;\n');
      fixture = knip(dir, "--include-entry-exports").filter((h) => IN_SCOPE.test(h.file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    repo = knip(process.cwd(), "--include-entry-exports").filter((h) => IN_SCOPE.test(h.file));
    prod = knip(process.cwd(), "--production");
  }, 60_000);

  test("fixture: an entry's own export and a script-re-exported dead export are caught; both reports can fail", () => {
    expect(fixture.map(label).sort()).toEqual(["src/index.ts [exports] entryDead", "src/lib.ts [exports] dead", "src/lib.ts [types] Dead"]);
    const r = rosterReport(fixture, [{ file: "src/lib.ts", code: "gone", count: 1, reason: "made-up: x" }, { file: "src/index.ts", code: "entryDead", count: 1, reason: "handler: x" }]);
    const b = baselineReport(fixture, ["src/lib.ts [exports] dead", "src/lib.ts [exports] gone"]);
    expect([r.unrostered.length, r.stale.length, r.badReason.length, b.unrostered.length, b.stale.length]).toEqual([2, 1, 2, 2, 1]);
  });

  test("default arm: every unused export is deleted, un-exported or rostered", () => {
    expectClean(rosterReport(repo, ROSTER), DEFAULT_MSG);
  });

  test("--production arm: test-only exports match the baseline", () => {
    expectClean(baselineReport(prod, JSON.parse(readFileSync(BASELINE, "utf8")) as string[]), PROD_MSG);
  });
});
