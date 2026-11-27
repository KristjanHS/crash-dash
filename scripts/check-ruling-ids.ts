/**
 * Lint (pre-commit, `npm run check`, pre-push, ship.sh): blocks a change that mints or spreads a plan-local ruling ID (letter + digits) in code prose.
 * Cite the plan by stem + the symbol instead. Usage: `git diff -U0 -M <range> | npx tsx scripts/check-ruling-ids.ts`,
 * or `--base <ref>` to diff the working tree against its merge-base with `<ref>` (`npm run lint:ruling-ids`); pre-commit pipes the staged diff, pre-push and ship.sh the push range.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TRANCHE_IDS } from "../src/ladder-live.js";
import { ALL_INDICATORS } from "../src/registry.js";

/** Registry indicator ids, the dial name and the re-entry tranche names are not plan-local rulings. */
const EXEMPT_IDS = new Set(["T1", ...TRANCHE_IDS, ...ALL_INDICATORS.map((i) => i.id).filter((id) => /^[A-Z][0-9]{1,2}$/.test(id))]);
const SCANNED_PATH = /^(src|api|scripts|public)\/.*\.(ts|js|mjs|cjs|sh|css|html)$/;
const UNSCANNED_PATH = /^scripts\/archive\//;
// `(?!-)`: geo flags (`G4-hormuz`) are config slugs, not rulings.
const ID = /(?<![\w-])([A-Z])([0-9]{1,2})(?:\.[0-9]+)*[a-z]?\b(?!-)/g;
const TEST_TITLE = /^\s*(?:describe|it|test)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;
const STRING = /(["'`])(?:\\.|(?!\1).)*\1/g;

export interface Violation {
  file: string;
  id: string;
  line: string;
}

/** The prose a line carries: whole-line or trailing comments plus test titles; code is never scanned. */
export function prosePart(line: string, file: string): string {
  const t = line.trim();
  if (/^(\/\/|\/\*|\*|<!--)/.test(t) || (file.endsWith(".sh") && t.startsWith("#"))) return t;
  const parts: string[] = [];
  const code = line.replace(STRING, '""');
  const trailing = code.match(/\s(\/\/|\/\*)(.*)$/);
  if (trailing) parts.push(trailing[2]!);
  if (file.endsWith(".sh")) {
    const shTrailing = code.match(/\s#\s(.*)$/);
    if (shTrailing) parts.push(shTrailing[1]!);
  }
  const title = line.match(TEST_TITLE);
  if (title) parts.push(title[2]!);
  return parts.join(" ");
}

export function rulingIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(ID)) {
    const [, letter = "", digits = ""] = m;
    const id = letter + digits;
    if (!EXEMPT_IDS.has(id)) ids.push(id);
  }
  return ids;
}

/** Across the whole push diff, an ID on more `+` than `-` prose lines is net-new — every `+` site is reported; moved or reworded cites pass. */
export function findNetNewRulingIds(diff: string): Violation[] {
  const net = new Map<string, { count: number; sites: Violation[] }>();
  let oldFile = "";
  let newFile = "";
  let inHeader = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      [inHeader, oldFile, newFile] = [true, "", ""];
      continue;
    }
    if (raw.startsWith("@@")) inHeader = false;
    if (inHeader && raw.startsWith("--- ")) {
      oldFile = raw.slice(4).replace(/^a\//, "");
      continue;
    }
    if (inHeader && raw.startsWith("+++ ")) {
      newFile = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const sign = raw[0];
    if (sign !== "+" && sign !== "-") continue;
    const file = sign === "+" ? newFile : oldFile;
    if (!SCANNED_PATH.test(file) || UNSCANNED_PATH.test(file)) continue;
    const body = raw.slice(1);
    for (const id of new Set(rulingIds(prosePart(body, file)))) {
      const e = net.get(id) ?? { count: 0, sites: [] };
      e.count += sign === "+" ? 1 : -1;
      if (sign === "+") e.sites.push({ file, id, line: body.trim() });
      net.set(id, e);
    }
  }
  return [...net.values()].filter((e) => e.count > 0).flatMap((e) => e.sites);
}

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The working tree's scanned-path diff against the merge-base of `base` and HEAD (uncommitted edits included). */
export function diffAgainst(base: string): string {
  const git = (args: string[]): string => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  let fork: string;
  try {
    fork = git(["merge-base", base, "HEAD"]).trim();
  } catch {
    console.error(`[ruling-ids] ✖ no merge-base between ${base} and HEAD — \`git fetch origin\`, or pass --base <ref>.`);
    process.exit(1);
  }
  return git(["diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", fork, "--", "src", "api", "scripts", "public"]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const baseAt = process.argv.indexOf("--base");
  if (baseAt >= 0 && !process.argv[baseAt + 1]) throw new Error("usage: check-ruling-ids.ts [--base <ref>]");
  const violations = findNetNewRulingIds(baseAt >= 0 ? diffAgainst(process.argv[baseAt + 1]!) : readFileSync(0, "utf8"));
  if (violations.length) {
    console.error("[ruling-ids] ✖ net-new plan-local ruling IDs in code prose:");
    for (const v of violations) console.error(`  ${v.file}: ${v.id}  ← ${v.line.slice(0, 120)}`);
    console.error("[ruling-ids]   Cite the plan by stem + symbol instead.");
    process.exit(1);
  }
}
