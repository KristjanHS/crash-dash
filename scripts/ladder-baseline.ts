/**
 * `npx tsx scripts/ladder-baseline.ts [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]` — the quality side of a run-cost check (`scripts/ladder-profile.py` is the cost side):
 * per leg, over the commits of `LEGS[leg].json` in the window (committer date, default the last 5 days): `commits` counted, `runs` = the
 * research runs among them (a row `checked` on the state's `run` — an idle run researches nothing and would dilute the means), `leanHitRate`
 * at the window's last commit (`planRun`), and over the research runs only: the mean share of sign rows whose lean carries ` (press only)` /
 * ` (single-source)`, and the mean count of `UNSOURCED` labels among the rows checked that run. Pair with `scripts/ladder-profile.py` (the token side); a slice
 * holds when these sit within noise of the 2026-10-13 → 10-16 table in T1's commit message.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LEGS, type LadderLegId, type LadderLive } from "../src/ladder-live.js";
import { addDays, planRun } from "../src/ladder-run.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const until = arg("until") ?? new Date().toLocaleDateString("sv-SE");
const since = arg("since") ?? addDays(until, -5);
const git = (...a: string[]): string => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

console.log(`window ${since}..${until} (run commits of public/<leg>.json)`);
console.log("leg    commits  runs  leanHitRate (last run)       press-only  single-src  UNSOURCED/run");
for (const leg of Object.keys(LEGS) as LadderLegId[]) {
  const shas = git("log", "--format=%H", `--since=${since}T00:00:00`, `--until=${until}T23:59:59`, "--", LEGS[leg].json).trim().split("\n").filter(Boolean).reverse();
  const lives = shas.flatMap((sha) => {
    try {
      return [JSON.parse(git("show", `${sha}:${LEGS[leg].json}`)) as LadderLive];
    } catch {
      return [];
    }
  });
  if (!lives.length) {
    console.log(`${leg.padEnd(5)}        0     0`);
    continue;
  }
  const runs = lives.filter((l) => l.signs.some((s) => s.checked === l.run));
  const mean = (f: (l: LadderLive) => number): number => (runs.length ? runs.reduce((a, l) => a + f(l), 0) / runs.length : NaN);
  const share = (suffix: string) => mean((l) => l.signs.filter((s) => s.lean.includes(suffix)).length / Math.max(1, l.signs.length));
  const last = lives.at(-1)!;
  let hit = "—";
  try {
    hit = planRun(last, last.run, leg).leanHitRate ?? "— (no calls)";
  } catch (e) {
    hit = `— (${(e as Error).message.slice(0, 40)})`;
  }
  const unsourced = mean((l) => l.signs.filter((s) => s.checked === l.run && s.label === "UNSOURCED").length);
  console.log(`${leg.padEnd(5)}  ${String(lives.length).padStart(7)}  ${String(runs.length).padStart(4)}  ${hit.padEnd(28)} ${pct(share(" (press only)")).padStart(8)}   ${pct(share(" (single-source)")).padStart(8)}   ${unsourced.toFixed(2).padStart(8)}`);
}
