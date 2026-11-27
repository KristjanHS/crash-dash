// One-shot fetch tool (Stage 1, E2 replay spec): pull the full HY-OAS history from the
// Internet Archive capture of FRED's full-table page and emit data/BAMLH0A0HYM2-vintage.csv.
// FRED clamps BAMLH0A0HYM2 to 3 years everywhere (site, fredgraph.csv, ALFRED) since Apr 2026,
// so this archived 2025-04-13 capture is the free full-history source (1996-12-31 → 2025-04-10).
// Regenerate: npx tsx scripts/fetch-hyoas-vintage.ts
import { writeFileSync } from "node:fs";

const ARCHIVE_URL =
  "https://web.archive.org/web/20250413085514/https://fred.stlouisfed.org/data/BAMLH0A0HYM2";
const OUT_PATH = new URL("../data/BAMLH0A0HYM2-vintage.csv", import.meta.url);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Extract (date, value) observation pairs from the archived page body.
 *  The capture renders the first ~1000 observations as HTML table rows
 *  (<th>DATE</th><td>VALUE</td>) and the remainder as compact lazy-load
 *  lines of the form "#DATE| VALUE". Merge both, dedupe by date. */
function extractObservations(body: string): Array<{ date: string; value: string }> {
  const byDate = new Map<string, string>();
  const add = (date: string, value: string) => {
    const prev = byDate.get(date);
    if (prev !== undefined && prev !== value) {
      throw new Error(`conflicting values for ${date}: ${prev} vs ${value}`);
    }
    byDate.set(date, value);
  };
  const tableRe =
    /<t[dh][^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/t[dh]>\s*<t[dh][^>]*>\s*(\.|-?\d+(?:\.\d+)?)\s*<\/t[dh]>/g;
  for (const m of body.matchAll(tableRe)) add(m[1]!, m[2]!);
  const hashRe = /^\s*#(\d{4}-\d{2}-\d{2})\|\s*(\.|-?\d+(?:\.\d+)?)\s*$/;
  for (const line of body.split("\n")) {
    const m = line.match(hashRe);
    if (m) add(m[1]!, m[2]!);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value }));
}

const res = await fetch(ARCHIVE_URL, { headers: { "user-agent": "crash-dash-vintage-fetch" } });
if (!res.ok) throw new Error(`archive fetch failed: ${res.status} ${res.statusText}`);
const body = await res.text();

const raw = extractObservations(body);
if (raw.length < 7000) {
  throw new Error(`parsed only ${raw.length} observations — page shape changed or capture truncated`);
}

const rows: Array<{ date: string; value: number }> = [];
for (const { date, value } of raw) {
  if (value === ".") continue; // FRED missing-value marker
  if (!DATE_RE.test(date)) throw new Error(`bad date: ${date}`);
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0 || v > 30) throw new Error(`out-of-range value ${value} on ${date}`);
  rows.push({ date, value: v });
}
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
for (let i = 1; i < rows.length; i++) {
  if (rows[i]!.date === rows[i - 1]!.date) throw new Error(`duplicate date: ${rows[i]!.date}`);
}

const csv = "date,value\n" + rows.map((r) => `${r.date},${r.value}`).join("\n") + "\n";
writeFileSync(OUT_PATH, csv);
console.log(
  `wrote ${rows.length} rows: ${rows[0]!.date} → ${rows[rows.length - 1]!.date} (${OUT_PATH.pathname})`,
);
