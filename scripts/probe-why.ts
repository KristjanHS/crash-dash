/**
 * Value provenance for one indicator-day (a retired plan A1): every stored row for
 * (id, date), which one `readings_latest` serves and why. Read-only.
 *
 *   npm run why -- <id> <YYYY-MM-DD>                     # prod (read-only)
 *   npx tsx scripts/probe-why.ts <id> <YYYY-MM-DD>       # local dev stack
 *
 * Exit 1 when the view's served row is not the `pickRecent` winner over the raw rows.
 */
import { pickRecent } from "../src/estimated.js";
import { isProvisional } from "../src/intraday.js";
import type { ReadStore, SeriesPoint } from "../src/store.js";

type Version = SeriesPoint & { runAt: string };
export type WhyRow = Version & { provisional: boolean; served: boolean };
export interface WhyReport {
  rows: WhyRow[];
  reason: string;
  viewAgrees: boolean;
  /** Newest served rows before `date` — filled only when `date` has no row. */
  earlier: SeriesPoint[];
}

const isEst = (p: SeriesPoint): boolean => p.estimated === true;

/** The `pickRecent` key that separates `winner` from each loser, tallied. */
export function servedReason(versions: readonly Version[], winner: Version | undefined): string {
  if (winner === undefined) return "no stored row";
  if (versions.length === 1) return "only stored row";
  const keys = new Map<string, number>();
  for (const v of versions) {
    if (v === winner) continue;
    const key = isEst(v) !== isEst(winner) ? "final beats estimate" : v.runAt !== winner.runAt ? "newer run_at" : "later insert";
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return [...keys].map(([k, n]) => `${k} ×${n}`).join(", ");
}

const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export async function whyReport(store: ReadStore, id: string, date: string): Promise<WhyReport> {
  const versions = (await store.getReadingVersions(id, date)).map((v) => {
    if (v.runAt === undefined) throw new Error(`[why] ${id} ${date}: a stored row has no run_at`);
    return v as Version;
  });
  const winner = versions.reduce<Version | undefined>(pickRecent, undefined);
  const [viewRow] = await store.getSeries(id, 1, { from: date, to: date });
  const viewAgrees =
    viewRow === undefined
      ? winner === undefined
      : winner !== undefined && viewRow.runAt === winner.runAt && sameValue(viewRow.value, winner.value) && isEst(viewRow) === isEst(winner);
  return {
    rows: versions.map((v) => ({ ...v, provisional: isProvisional(v, id), served: v === winner })),
    reason: servedReason(versions, winner),
    viewAgrees,
    earlier: winner === undefined ? await store.getSeries(id, 3, { to: date }) : [],
  };
}

export function formatReport(id: string, date: string, r: WhyReport): string[] {
  const flag = (on: boolean, s: string) => (on ? s : "·").padEnd(5);
  // A cell always ends in ≥1 space, so a value wider than its column (full-precision floats) never glues onto the next one.
  const cell = (s: string, w: number) => `${s.padEnd(w - 1)} `;
  const lines = [`${id} ${date}`, `${"run_at".padEnd(31)}${"value".padEnd(14)}${"raw→state".padEnd(14)}est  prov`];
  for (const row of r.rows) {
    lines.push(
      `${cell(row.runAt, 31)}${cell(String(row.value), 14)}${cell(`${row.rawState}→${row.state}`, 14)}${flag(isEst(row), "✓")}${flag(row.provisional, "✓")}${row.served ? "◄ served" : ""}`,
    );
  }
  lines.push(`why served: ${r.reason}`);
  if (r.earlier.length > 0) lines.push(`nearest earlier served: ${r.earlier.map((p) => `${p.date}=${p.value}${isEst(p) ? " (est)" : ""}`).join(", ")}`);
  lines.push(r.viewAgrees ? "readings_latest agrees" : "MISMATCH: readings_latest serves a different row than pickRecent (a cron write between the reads also trips this — re-run to confirm)");
  return lines;
}

async function main(): Promise<void> {
  const env = process.argv.includes("--env=prod") ? "prod" : "local";
  const [id, date] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (id === undefined || date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("usage: npm run why -- <id> <YYYY-MM-DD>");
  if (env === "local") process.loadEnvFile(".env.local");
  const { resolveStore } = await import("./backfill/resolve-store.js");
  const report = await whyReport(await resolveStore(env, "ro"), id, date);
  for (const line of formatReport(id, date, report)) console.log(line);
  if (!report.viewAgrees) process.exitCode = 1;
}

const isDirect = process.argv[1]?.endsWith("probe-why.ts") === true;
if (isDirect) {
  await main();
}
