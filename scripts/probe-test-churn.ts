/** Lists test files with ≥ MIN_QUALIFYING commits in a range whose hunks are only numeric matcher bumps and/or comments.
 *  `npm run probe:test-churn -- --since=<ref> [--until=<ref>]` — audit tooling, always exit 0 (plan audit-5 §5.1 T5). */
import { execFileSync } from "node:child_process";

export const MIN_QUALIFYING = 3;
const COMMIT_MARK = "\u0000";
const NUMERIC_MATCHER =
  /\.(toBe|toEqual|toStrictEqual|toHaveLength|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual)\(\s*-?\d+(?:\.\d+)?\s*\)/g;
const HAS_NUMERIC_MATCHER = new RegExp(NUMERIC_MATCHER.source);

const isComment = (body: string): boolean => /^(\/\/|\/\*|\*)/.test(body.trim());

/** True iff the changed lines (`+`/`-` prefixed) are only comments and/or numeric-literal matcher bumps. */
export function isChurnHunk(lines: readonly string[]): boolean {
  const removed: string[] = [];
  const added: string[] = [];
  let substantive = 0;
  for (const line of lines) {
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    const body = line.slice(1);
    if (body.trim() === "") continue;
    substantive++;
    if (isComment(body)) continue;
    if (!HAS_NUMERIC_MATCHER.test(body)) return false;
    const norm = body.replace(NUMERIC_MATCHER, ".$1(N)").replace(/\s+\/\/.*$/, "").trim();
    (sign === "+" ? added : removed).push(norm);
  }
  if (substantive === 0) return false;
  removed.sort();
  added.sort();
  return removed.length === added.length && removed.every((r, i) => r === added[i]);
}

export interface ChurnRow {
  path: string;
  qualifying: number;
  total: number;
}

/** Parses `git log --format=%x00%H -p --unified=0` output into per-file qualifying/total commit counts. */
export function tallyChurn(log: string): ChurnRow[] {
  const counts = new Map<string, { qualifying: number; total: number }>();
  const flush = (path: string | null, lines: string[]): void => {
    if (path === null) return;
    const c = counts.get(path) ?? { qualifying: 0, total: 0 };
    c.total++;
    if (isChurnHunk(lines)) c.qualifying++;
    counts.set(path, c);
  };
  let path: string | null = null;
  let lines: string[] = [];
  let inHeader = false;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK) || line.startsWith("diff --git ")) {
      flush(path, lines);
      path = line.startsWith("diff --git ") ? line.slice(line.lastIndexOf(" b/") + 3) : null;
      lines = [];
      inHeader = path !== null;
      continue;
    }
    if (path === null) continue;
    if (line.startsWith("@@")) inHeader = false;
    else if (!inHeader) lines.push(line);
  }
  flush(path, lines);
  return [...counts.entries()]
    .map(([p, c]) => ({ path: p, ...c }))
    .filter((r) => r.qualifying >= MIN_QUALIFYING)
    .sort((a, b) => b.qualifying - a.qualifying || b.total - a.total || a.path.localeCompare(b.path));
}

function main(): void {
  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const since = arg("since");
  const until = arg("until") ?? "HEAD";
  if (since === undefined) {
    console.log("usage: npm run probe:test-churn -- --since=<ref> [--until=<ref>]");
    return;
  }
  const log = execFileSync(
    "git",
    ["log", "--no-color", "--no-ext-diff", "--no-renames", `--format=%x00%H`, "-p", "--unified=0",
      `${since}..${until}`, "--", "*.test.ts", "*.test.js"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const rows = tallyChurn(log);
  console.log(`test-churn ${since}..${until}: ${rows.length} file(s) with ≥ ${MIN_QUALIFYING} bump/comment-only commits`);
  for (const r of rows) console.log(`${String(r.qualifying).padStart(4)} / ${String(r.total).padEnd(4)} ${r.path}`);
}

const isDirect = process.argv[1]?.endsWith("probe-test-churn.ts") === true;
if (isDirect) main();
