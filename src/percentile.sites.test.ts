import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { RANKER_BY_SITE } from "./percentile.js";

// ---------------------------------------------------------------------------------------
// RANKER_BY_SITE — the history-ranker answer key (percentile.ts) held honest.
//
// The table is DATA: nothing ranks through it. These assertions are the half that works.
// Each site is checked against the REAL import statements of the files it names, the table is
// checked for completeness against a walk of src/ · api/ · scripts/, and the two rankers are
// driven far enough apart to show the window semantics that made the merge a non-option.
// ---------------------------------------------------------------------------------------
describe("RANKER_BY_SITE - every history-ranking site matches its table entry", () => {
  /** Ranker symbols, per implementation. A non-ranker import (`smaDeviation`,
   *  `LEG_PILLAR_GENERATOR`) does not make a file a site. */
  const SYMBOLS = {
    expanding: ["quantile", "expandingPercentile", "rollingPercentile", "percentileRank", "PCT_MIN_OBS"],
    "rolling-ecdf": ["rollingEcdfRank", "ECDF_WINDOW", "ECDF_READ_SLACK", "ECDF_READ_SPAN"],
  } as const;

  const NAMED_FROM = /(?:import|export)\s*(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]*)"/g;
  const RE_EXPORT_FROM = /export\s*\{([^}]*)\}\s*from\s*"([^"]*)"/g;

  const namesOf = (clause: string): string[] =>
    clause.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
  const basename = (spec: string): string => spec.slice(spec.lastIndexOf("/") + 1);
  const directKind = (spec: string): keyof typeof SYMBOLS | undefined =>
    spec.endsWith("leg-percentile.js") ? "rolling-ecdf" : spec.endsWith("percentile.js") ? "expanding" : undefined;

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
    );
  const DEFINITIONS = ["src/percentile.ts", "src/leg-percentile.ts"];
  const SOURCES = ["src", "api", "scripts"]
    .flatMap((d) => walk(d))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts") && !DEFINITIONS.includes(f));

  /** ONE HOP OF RE-EXPORT. `slow.ts` re-exports the expanding rankers, so a consumer importing
   *  them from `./slow.js` is a ranking site the definition-file specifier alone cannot see —
   *  the hole that let two live `src/` sites go unlisted. Barrels are DERIVED, never listed, so a
   *  future barrel is covered without editing this walk. */
  const barrels = new Map<string, keyof typeof SYMBOLS>();
  for (const file of SOURCES) {
    for (const m of readFileSync(file, "utf8").matchAll(RE_EXPORT_FROM)) {
      const kind = directKind(m[2]!);
      if (kind && namesOf(m[1]!).some((n) => (SYMBOLS[kind] as readonly string[]).includes(n))) {
        barrels.set(basename(file).replace(/\.ts$/, ".js"), kind);
      }
    }
  }

  /** Rankers a file actually imports, read off its source — directly or through a barrel. */
  const rankersOf = (file: string): Set<string> => {
    const src = readFileSync(file, "utf8");
    const out = new Set<string>();
    for (const m of src.matchAll(NAMED_FROM)) {
      const spec = m[2]!;
      const kind = directKind(spec) ?? barrels.get(basename(spec));
      if (!kind) continue;
      if (namesOf(m[1]!).some((n) => (SYMBOLS[kind] as readonly string[]).includes(n))) out.add(kind);
    }
    return out;
  };

  test("the re-export hop is live: `slow.js` resolves as an expanding-ranker barrel", () => {
    // Anti-vacuity for the completeness walk below. Without this, a regex that silently stopped
    // matching re-exports would take the walk back to direct-import-only and green over every
    // barrel consumer — exactly the failure this test file shipped with.
    expect(barrels.get("slow.js")).toBe("expanding");
  });

  test("every listed file really imports the ranker the table claims", () => {
    const entries = Object.entries(RANKER_BY_SITE);
    expect(entries.length).toBeGreaterThan(0); // vacuity guard
    for (const [site, entry] of entries) {
      for (const file of entry.files) {
        expect([...rankersOf(file)], `${site} → ${file} (${entry.ranks})`).toEqual([entry.ranker]);
      }
      // Per-site pin: the sites carrying their OWN floor (ECY's monthly one, R7's rank warm-up,
      // F5/SPCONC's rolling window) are named individually — a toContain over the set would green
      // a wrong `via` on every other expanding site.
      const OWN_FLOOR: Record<string, string> = {
        ecyExpensiveCut: "ECY_MIN_OBS",
        bullSteepenerCuts: "BULL_MIN_OBS",
        breadthBand: "BREADTH_CUT_WINDOW",
      };
      expect(entry.via, site).toBe(entry.ranker === "expanding" ? (OWN_FLOOR[site] ?? "PCT_MIN_OBS") : "ECDF_WINDOW");
    }
    // Both rankers are in use — an entry set that drifted to one ranker would make the
    // not-a-merge invariant below vacuous.
    expect(new Set(entries.map(([, e]) => e.ranker))).toEqual(new Set(["expanding", "rolling-ecdf"]));
  });

  test("no unlisted ranking site exists under src/ · api/ · scripts/", () => {
    expect(SOURCES.length).toBeGreaterThan(20); // vacuity guard — the walk found real files

    const found = SOURCES.filter((f) => rankersOf(f).size > 0);
    const listed = new Set(Object.values(RANKER_BY_SITE).flatMap((s) => s.files));
    expect(found.sort()).toEqual([...listed].sort());
  });
});
