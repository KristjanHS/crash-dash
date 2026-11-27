/** Every `probe:*` npm entry is cited by a tracked file outside its own script, `package.json` and
 *  `docs/plans/archive/`, or sits in STANDING_PROBES — archiving a plan drops the entries only it cites. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/probe-entries.test.ts";

/** Reusable tools with no live cite; add here only a probe a future session would re-run unprompted. */
const STANDING_PROBES = [
  "cron-cpu",
  "cron-latency",
  "dast",
  "db-first-rollout",
  "db-trace",
  "defleg-live",
  "drawdown-bite",
  "drawdown-clamp-2022",
  "email-send",
  "eufin-tranches",
  "fx-weekend-labels",
  "leg-span",
  "leg-span:dev",
  "load-budget",
  "member-contribution",
  "outcomes",
  "parity",
  "perf-baseline",
  "provisional-rows",
  "series-holes",
  "test-churn",
  "turn-timing",
];

const scripts: Record<string, string> = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).scripts;
const probes = Object.keys(scripts).filter((k) => k.startsWith("probe:")).map((k) => k.slice("probe:".length));

const TEXT = /\.(ts|js|mjs|cjs|md|sh|json|ya?ml|html)$|(^|\/)Makefile$/;
/** `make ship` runs this in a `git archive HEAD` copy with no `.git` (ship.sh §0b): there the tree IS the
 *  tracked set, plus the symlinked gitignored inputs (node_modules, .env*) — so walk it, skipping symlinks. */
function walkTree(dir = ""): string[] {
  return readdirSync(`${ROOT}${dir}`, { withFileTypes: true }).flatMap((e) =>
    e.isSymbolicLink() ? [] : e.isDirectory() ? walkTree(`${dir}${e.name}/`) : [`${dir}${e.name}`],
  );
}
/** Tracked files containing `probe:` — one `git grep`; the walk (every file) when git is absent or fails. */
function candidates(): string[] {
  if (existsSync(`${ROOT}.git`)) {
    try {
      return execFileSync("git", ["grep", "-l", "-F", "probe:"], { cwd: ROOT, encoding: "utf8" }).split("\n");
    } catch {
      // fall through to the walk
    }
  }
  return walkTree();
}
/** Per file, every `probe:<name>` it cites — the maximal `[\w:-]` run, read at each occurrence (zero-width, so none is consumed). */
function scanCites(): (readonly [string, Set<string>])[] {
  return candidates()
    .filter((f) => TEXT.test(f))
    .filter((f) => f !== "package.json" && f !== "package-lock.json" && f !== SELF)
    .filter((f) => !f.startsWith("docs/plans/archive/") && !f.startsWith("scripts/archive/"))
    .map((f) => {
      const body = readFileSync(`${ROOT}${f}`, "utf8");
      const names = new Set<string>();
      if (body.includes("probe:")) for (const m of body.matchAll(/probe:(?=([\w:-]+))/g)) names.add(m[1]!);
      return [f, names] as const;
    });
}
let cites: (readonly [string, Set<string>])[];

/** A probe's own script — and that script's own `<script>.test.ts` — is not a live cite. */
function citedOutsideOwnScript(name: string): boolean {
  const scriptsOf: string[] = (scripts[`probe:${name}`] ?? "").match(/scripts\/[\w./-]+\.(?:ts|sh|mjs|cjs)/g) ?? [];
  const own = scriptsOf.flatMap((f) => [f, f.replace(/\.\w+$/, ".test.ts")]);
  return cites.some(([f, names]) => !own.includes(f) && names.has(name));
}

describe("probe:* npm entries ride plan archival", () => {
  beforeAll(() => {
    cites = scanCites();
  });

  it("every probe entry has a live cite or is STANDING", () => {
    const orphans = probes.filter((p) => !STANDING_PROBES.includes(p) && !citedOutsideOwnScript(p));
    expect(orphans, "drop these package.json entries (the script stays runnable via `npx tsx`)").toEqual([]);
  });

  it("every STANDING_PROBES name is a real entry", () => {
    expect(STANDING_PROBES.filter((p) => !probes.includes(p))).toEqual([]);
  });
});
