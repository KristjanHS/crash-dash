/**
 * Data layer: keyless US Treasury daily yield curves — the same-day HEAD for rate ids FRED publishes
 * T+1. FRED stays the history.
 *
 *   <BASE>/<year>/all?type=daily_treasury_yield_curve       nominal — "10 YR" ≡ DGS10, "2 YR" ≡ DGS2
 *   <BASE>/<year>/all?type=daily_treasury_real_yield_curve  real    — "10 YR" ≡ DFII10
 *
 * ⚠ The two files spell the same tenor in DIFFERENT case ("10 Yr" vs "10 YR") — every column key here
 * is UPPERCASED, and a lookup that skips `.toUpperCase()` silently grafts nothing.
 *
 * Fetch/parse failures THROW; `fetchTreasuryCurveSafe` degrades them to an empty map, so a Treasury
 * hiccup leaves the plain FRED series rather than aborting the run.
 *
 * Standing falsifier that the Treasury≡FRED equality has not drifted: `npm run probe:rate-feed-parity`.
 */

import type { Observation } from "./domain-types.js";
import { headObs } from "./domain-types.js";
import { type FetchLike, fetchText } from "./feed-http.js";
import { runMemo } from "./run-memo.js";

export type TreasuryCurve = "nominal" | "real";

const BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";
const CSV_TYPE: Record<TreasuryCurve, string> = {
  nominal: "daily_treasury_yield_curve",
  real: "daily_treasury_real_yield_curve",
};
const TIMEOUT_MS = 15_000;

/**
 * Shared dates the equality gate needs before it may ESTABLISH. The CSV is per-YEAR, so the first
 * weekday runs of January see only the new year's rows — too thin to prove parity, and the graft then
 * degrades to FRED rather than trusting an unchecked head.
 */
export const MIN_OVERLAP_ROWS = 5;

/**
 * Treasury's CSVs never escape a quote inside a quoted field (`""`) — that, not comma-in-quotes, is the
 * unhandled case; a comma inside quotes parses correctly via the `!quoted` guard. A format change that
 * introduced `""` fails safe: the header then misses `DATE` and throws, or a cell yields NaN and is skipped.
 */
function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** `09/18/2026` → `2026-09-18`; anything else (a banner or footer row) → undefined. */
function usDateToIso(cell: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cell.trim());
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : undefined;
}

/**
 * Treasury curve CSV → one `Observation[]` per tenor, oldest→newest, keyed by the UPPERCASED column
 * header. Holidays are absent rows and discontinued/unpublished tenors are blank or `N/A` cells — both
 * are skipped per-cell, so one gap never truncates a sibling tenor. Zero rate rows throws.
 * @internal
 */
export function parseTreasuryCurveCsv(text: string): Map<string, Observation[]> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines.shift();
  if (header === undefined) throw new Error("treasury CSV: empty body");
  const cols = splitCsvRow(header).map((c) => c.toUpperCase());
  if (cols[0] !== "DATE") throw new Error(`treasury CSV: unexpected header: ${header.slice(0, 120)}`);

  const byColumn = new Map<string, Observation[]>();
  for (let c = 1; c < cols.length; c++) byColumn.set(cols[c]!, []);

  let rows = 0;
  for (const line of lines) {
    const cells = splitCsvRow(line);
    const date = usDateToIso(cells[0] ?? "");
    if (date === undefined) continue;
    for (let c = 1; c < cols.length; c++) {
      const raw = cells[c] ?? "";
      if (raw === "" || raw.toUpperCase() === "N/A") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      byColumn.get(cols[c]!)!.push({ date, value });
      rows++;
    }
  }
  if (rows === 0) throw new Error(`treasury CSV: no rate rows (error / empty body?): ${text.slice(0, 120)}`);

  for (const series of byColumn.values()) series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return byColumn;
}

export type TreasuryDeps = { fetchImpl?: FetchLike; warn?: (...args: unknown[]) => void };

/** One year's curve, straight off the wire. Throws on a non-OK status or an unparseable body. */
async function fetchTreasuryCurve(
  curve: TreasuryCurve,
  year: number,
  { fetchImpl }: TreasuryDeps = {},
): Promise<Map<string, Observation[]>> {
  const params = new URLSearchParams({
    type: CSV_TYPE[curve],
    field_tdr_date_value: String(year),
    _format: "csv",
  });
  const url = `${BASE}/${year}/all?${params.toString()}`;
  return parseTreasuryCurveCsv(await fetchText(url, { fetchImpl, timeoutMs: TIMEOUT_MS, label: `treasury ${curve} fetch failed` }));
}

function copyCurve(curve: Map<string, Observation[]>): Map<string, Observation[]> {
  return new Map([...curve].map(([tenor, series]) => [tenor, series.map((o) => ({ ...o }))]));
}

// ⛔ NEVER an always-armed memo (fred.ts's `fredMemo`, same reason): off the cron path nothing
// bounds its lifetime and a warm lambda would serve one run's Treasury vintage to the next.
const treasuryMemo = runMemo<string, Map<string, Observation[]>>({ copy: copyCurve });

/** A curve fetch failure, reported once per (curve, year) per run — the cron passes `recordDegrade`. */
export type TreasuryFail = (curve: TreasuryCurve, year: number, err: unknown) => void;
let runFail: { onFail: TreasuryFail; reported: Set<string> } | null = null;

/** Arm a fresh per-run Treasury memo — R2 and R3 share the nominal CSV, so this is one fetch, not two. */
export function startTreasuryMemo(opts: { onFail?: TreasuryFail } = {}): void {
  treasuryMemo.start();
  runFail = opts.onFail ? { onFail: opts.onFail, reported: new Set() } : null;
}

/** Disarm the memo (test isolation, and any caller that must see every fetch go to the wire). */
export function stopTreasuryMemo(): void {
  treasuryMemo.stop();
  runFail = null;
}

/**
 * Never throws: a Treasury hiccup warns (naming the curve), reaches the run's `onFail` sink (`startTreasuryMemo`) once per
 * (curve, year), and yields an empty map; `graftTreasuryHead` then returns FRED intact.
 * A REJECTED fetch is evicted from the memo (`fredMemo`'s contract) — caching the failure would forfeit
 * same-day freshness for every remaining id that run, on one blip, with no retry. The returned map is a
 * fresh copy down to the `Observation`s, so no caller can poison the memo.
 * @internal
 */
export async function fetchTreasuryCurveSafe(
  curve: TreasuryCurve,
  year: number,
  deps: TreasuryDeps = {},
): Promise<Map<string, Observation[]>> {
  try {
    return await treasuryMemo.get(`${curve}|${year}`, () => fetchTreasuryCurve(curve, year, deps));
  } catch (err) {
    (deps.warn ?? console.warn)(`[treasury] ${curve} ${year} curve fetch failed - FRED served without the same-day head:`, err);
    // Every id on one curve retries (the memo evicts failures), so the run sink dedupes per (curve, year).
    if (runFail && !runFail.reported.has(`${curve}|${year}`)) {
      runFail.reported.add(`${curve}|${year}`);
      runFail.onFail(curve, year, err);
    }
    return new Map();
  }
}

/** One tenor's observations, case-insensitively keyed. */
export async function fetchTreasuryColumn(
  curve: TreasuryCurve,
  column: string,
  year: number,
  deps: TreasuryDeps = {},
): Promise<Observation[]> {
  return (await fetchTreasuryCurveSafe(curve, year, deps)).get(column.toUpperCase()) ?? [];
}

/**
 * FRED history plus the Treasury rows STRICTLY newer than FRED's last observation — pure, and the one
 * place the equality gate lives. Returns `fred` untouched when a shared date disagrees or the overlap is
 * thinner than `MIN_OVERLAP_ROWS`: scoring a number FRED will contradict tomorrow is worse than a day of
 * staleness. Never rewrites a FRED row, so the next run's FRED print overwrites the graft rather than
 * blending with it. Head rows carry `estimated: true` (stored `estimated`, never FINAL — `estimateDatesOf`).
 */
export function graftTreasuryHead(fred: Observation[], treasury: Observation[]): Observation[] {
  if (fred.length === 0 || treasury.length === 0) return fred;
  const fredValue = new Map(fred.map((o) => [o.date, o.value]));
  const lastFred = fred.reduce((max, o) => (o.date > max ? o.date : max), fred[0]!.date);

  const head: Observation[] = [];
  const matched = new Set<string>(); // DISTINCT dates — a duplicate-dated input must not inflate the count
  for (const row of treasury) {
    if (row.date > lastFred) {
      head.push(headObs(row.date, row.value, "quote"));
      continue;
    }
    const mine = fredValue.get(row.date);
    if (mine === undefined) continue; // FRED has no print that day — nothing to compare
    if (mine !== row.value) return fred; // per-column drop: a sibling tenor keeps its own head
    matched.add(row.date);
  }
  if (head.length === 0 || matched.size < MIN_OVERLAP_ROWS) return fred;

  head.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return [...fred, ...head];
}
