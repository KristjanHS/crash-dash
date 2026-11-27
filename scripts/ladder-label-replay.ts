/** `npm run ladder:label-replay` — re-runs `prelabel` over the saved `/semis` runs (`ladder-label-replay.semis.json`) and diffs it against Opus's applied labels; exit 1 on any mismatch `RULED` does not list. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFindings } from "../src/ladder-findings.js";
import type { LadderSource } from "../src/ladder-live.js";
import { prelabel, type PrelabelRow } from "../src/ladder-prelabel.js";

export type ReplayFixture = {
  generatedBy: string;
  sessions: { id: string; today: string; rows: PrelabelRow[]; tables: string[]; applied: Record<string, { label: string; sources?: LadderSource[] }> }[];
};
type Mismatch = { session: string; today: string; sign: string; opus: string; rule: string; why: string };
export type ReplayResult = { sessions: number; compared: number; mismatches: Mismatch[]; open: Mismatch[] };

/** `<session 8>/<sign>` → [USER 2026-11-14] 6.4 ruling: `legacy-format` = a free-worded no-item line dated in-window (Opus right); `opus-miss` = Opus left out a newer agreeing source (rule right). */
export const RULED: Readonly<Record<string, "legacy-format" | "opus-miss">> = {
  "ba76dd21/tsmc_monthly": "legacy-format", "562a048e/capex_guides": "legacy-format", "46314723/capex_guides": "legacy-format", "6fc7207c/tsmc_monthly": "legacy-format",
  "6fc7207c/capex_guides": "legacy-format", "0124ee9e/capex_guides": "legacy-format", "0124ee9e/lab_revenue": "legacy-format", "05c62328/mu_dio": "legacy-format",
  "98c848e7/capex_guides": "legacy-format", "41af947d/capex_guides": "legacy-format", "562a048e/tsmc_monthly": "opus-miss", "46314723/tsmc_monthly": "opus-miss",
};
export const ruledKey = (m: { session: string; sign: string }): string => `${m.session.slice(0, 8)}/${m.sign}`;

export const FIXTURE = fileURLToPath(new URL("ladder-label-replay.semis.json", import.meta.url));
const DATED = /^(UNCHANGED|STALE) (\d{2}-\d{2})$/;

/** Mechanical pre-labels must equal Opus's label; a judgement row only checks the MM-DD on Opus's dated `UNCHANGED`/`STALE`. */
export const replay = (fixture: ReplayFixture): ReplayResult => {
  let compared = 0;
  const mismatches: Mismatch[] = [];
  for (const s of fixture.sessions) {
    const { rows } = prelabel(s.rows, s.tables.flatMap(parseFindings), s.today);
    for (const p of rows) {
      const opus = s.applied[p.sign]?.label;
      const rule = p.label ?? `<judgement> ${p.date ?? "—"}`;
      const miss = (why: string): number => mismatches.push({ session: s.id, today: s.today, sign: p.sign, opus: opus ?? "—", rule, why });
      if (opus === undefined) { compared++; miss("missing"); continue; }
      if (p.label !== undefined) { compared++; if (opus !== p.label) miss(p.why); continue; }
      const m = DATED.exec(opus);
      if (!m) continue;
      compared++;
      if (m[2] !== p.date) miss("judgement date");
    }
  }
  return { sessions: fixture.sessions.length, compared, mismatches, open: mismatches.filter((m) => !(ruledKey(m) in RULED)) };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = replay(JSON.parse(readFileSync(FIXTURE, "utf8")) as ReplayFixture);
  if (r.mismatches.length) console.table(r.mismatches.map((m) => ({ ...m, session: m.session.slice(0, 8), ruled: RULED[ruledKey(m)] ?? "OPEN" })));
  console.log(`label-replay: ${r.sessions} sessions, ${r.compared} compared, ${r.mismatches.length} mismatches (${r.open.length} open)`);
  if (r.open.length) process.exit(1);
}
