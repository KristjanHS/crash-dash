/**
 * Stale-literal lint for the backfill-depth constants (`SYMBOLS` below): a numeral restating a constant's value rots the moment
 * the constant moves (the default depth went 15 → 3 in `src/series-db-first.ts` and six comments kept the old figure — the
 * `indicator-loop.md` §A retune is a ONE-place edit class). Scans every non-test `.ts` under `src/` and `scripts/` (this file
 * included) and fails on any line that names a symbol AND carries a year-numeral (`15y`, `3 years`, …), the definition line
 * excepted. Per-id depths belong to the registry `backfill` field — name THAT when a comment needs a number.
 * Exits 1 with a ✖ listing on a hit, on a shrunken scan population, or on a symbol cited in < 2 files outside its definition
 * and this file (a vacuous scan); silent on success. In `npm run check` / `check:cov`, `make ship` and CI.
 * Usage: `npm run -s lint:backfill-years`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const YEAR_NUMERAL = /\b\d+\s?-?(?:y|yr|yrs|year|years)\b/i;
/** The depth constants a comment may only ever cite by SYMBOL. */
export const SYMBOLS = ["BACKFILL_YEARS", "EXPANDING_PERCENTILE_PREFIX_YEARS"] as const;
/** This file: scanned for violations like any other, but its own `SYMBOLS` line never counts toward the ≥ 2-file anchor. */
const SELF = "scripts/lint-backfill-years.ts";

const isDefinition = (line: string, symbol: string): boolean => new RegExp(`^\\s*(export\\s+)?const\\s+\\w*${symbol}\\s*=`).test(line);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") out.push(...tsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Every violation over `files` (path → text): offending lines, plus the population / non-vacuity guards. */
export function violations(files: ReadonlyMap<string, string>): string[] {
  const bad: string[] = [];
  if (files.size <= 50) bad.push(`scan population shrank to ${files.size} files (expected > 50)`);
  if (![...files.keys()].some((f) => f.endsWith("series-db-first.ts"))) bad.push("scan population lost src/series-db-first.ts");
  for (const symbol of SYMBOLS) {
    let cites = 0;
    for (const [f, text] of files) {
      if (!text.includes(symbol)) continue;
      let cited = false;
      text.split("\n").forEach((line, i) => {
        if (!line.includes(symbol) || isDefinition(line, symbol)) return; // the DEFINITION only — a comment saying "= 15y" still trips
        cited = true;
        if (YEAR_NUMERAL.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
      if (cited && !f.endsWith(SELF)) cites++;
    }
    if (cites < 2) bad.push(`${symbol} is cited in ${cites} file(s) outside its definition and ${SELF} (expected ≥ 2 — the scan went vacuous)`);
  }
  return bad;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = new Map([...tsFiles(join(ROOT, "src")), ...tsFiles(join(ROOT, "scripts"))].map((f) => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")]));
  const bad = violations(files);
  if (bad.length) {
    for (const b of bad) console.error(`[backfill-years] ✖ ${b}`);
    console.error("[backfill-years] a line restates a depth constant's value — cite the constant, or the entry's registry `backfill` field");
    process.exit(1);
  }
}
