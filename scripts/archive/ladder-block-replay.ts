/**
 * ladder-block-replay.ts — every past and open sign BLOCK episode of the five ladder legs, off git history.
 *
 *   npm run probe:block-replay
 *
 * Walks `git log --reverse -- public/<leg>.json`, reads each version (`git show <sha>:…`), and tracks each
 * sign's holding block (`block: true`) from the version that sets it to the version that drops it. One line
 * per episode: leg · sign · set (the first-seen `blocked.on`, else the setting commit's date) · end · days · how it
 * ended — `open` (still blocked at HEAD), `row dropped` (the sign left the JSON), `released` (`blocked.reach:
 * "released"`), else the ending commit's subject (a lift by `resolveBlocks`, or a code/rule change).
 *
 * Lister only — no cause classifier (qimpag ruling 2026-11-13):
 * the replay's pre-registered stop resolved without one (2 past lifts, both structural, < REPLAY_MIN_LIFTS → the 6F arm);
 * the durations stay available for the Stage 7 expiry constants. Read-only: git `log`/`show` only.
 */
import { execFileSync } from "node:child_process";
import type { LadderLive } from "../../src/ladder-live.js";

const LEGS = ["eufin", "value", "semis", "spit", "sp500"] as const;
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const days = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

type Sign = Pick<LadderLive["signs"][number], "sign" | "block" | "blocked">;
export type Episode = { leg: string; sign: string; set: string; end?: string; days: number; how: string };

/** One leg's episodes from its versions in commit order: `{date, subject, signs}` per version. */
export const episodes = (leg: string, versions: readonly { date: string; subject: string; signs: readonly Sign[] }[], today: string): Episode[] => {
  const open = new Map<string, string>();
  const out: Episode[] = [];
  for (const v of versions) {
    const now = new Map(v.signs.map((s) => [s.sign, s]));
    for (const [sign, set] of open) {
      const s = now.get(sign);
      if (s?.block === true) continue;
      const how = !s ? "row dropped" : s.blocked?.reach === "released" ? "released" : v.subject;
      out.push({ leg, sign, set, end: v.date, days: days(set, v.date), how });
      open.delete(sign);
    }
    for (const s of v.signs) if (s.block === true && !open.has(s.sign)) open.set(s.sign, s.blocked?.on ?? v.date);
  }
  for (const [sign, set] of open) out.push({ leg, sign, set, days: days(set, today), how: "open" });
  return out;
};

const versionsOf = (leg: string): { date: string; subject: string; signs: Sign[] }[] =>
  git("log", "--reverse", "--format=%H %cs %s", "--", `public/${leg}.json`).trim().split("\n").filter(Boolean).flatMap((line) => {
    const [sha, date, ...subject] = line.split(" ");
    try {
      const live = JSON.parse(git("show", `${sha}:public/${leg}.json`)) as Partial<LadderLive>;
      return [{ date: date!, subject: subject.join(" ").slice(0, 80), signs: live.signs ?? [] }];
    } catch {
      return []; // a version that does not parse (or a delete) carries no signs to diff
    }
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  const today = new Date().toISOString().slice(0, 10);
  const all = LEGS.flatMap((leg) => episodes(leg, versionsOf(leg), today));
  for (const e of all) console.log([e.leg.padEnd(6), e.sign.padEnd(16), e.set, (e.end ?? "--").padEnd(10), `${e.days} d`.padStart(5), e.how].join("  "));
  const ended = all.filter((e) => e.end);
  console.log(`episodes ${all.length} | open ${all.length - ended.length} | ended ${ended.length} (row dropped ${ended.filter((e) => e.how === "row dropped").length}, released ${ended.filter((e) => e.how === "released").length})`);
}
