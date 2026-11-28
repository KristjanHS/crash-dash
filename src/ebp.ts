/**
 * Data layer: fetch + parse the keyless EBP (Excess Bond Premium / Gilchrist-
 * Zakrajšek) monthly CSV from the Federal Reserve. Full history 1973→ (the free
 * full-history credit-risk-appetite substitute the ≤3yr ICE OAS feed can't reach).
 * Abstracted behind one function so a
 * later sourcing swap is a single edit (v4 §9), same seam convention as fred.ts.
 *
 * EBP revises monthly; each run captures its as-of snapshot through the
 * append-only vintage store like any other reading — no special snapshot logic.
 */

import type { Observation } from "./domain-types.js";
import { fetchText } from "./feed-http.js";

const EBP_CSV_URL = "https://www.federalreserve.gov/econres/notes/feds-notes/ebp_csv.csv";

export async function fetchEbp(): Promise<Observation[]> {
  // Explicit UA + per-attempt timeout, same discipline as the FRED feed: turn a
  // datacenter-IP hang into a fast, logged failure. Composed with the run-wide fetch
  // deadline (fetch-budget.ts) so this term can't outlive the cycle's budget either.
  const text = await fetchText(EBP_CSV_URL, {
    init: { headers: { "User-Agent": "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)" } },
    timeoutMs: 15_000,
    label: "EBP fetch failed",
  });
  return parseEbpCsv(text);
}

/**
 * Normalize one EBP date cell to ISO `YYYY-MM-DD`.
 *
 * The Fed serves this file in TWO date formats and has switched between them
 * without notice: it published `YYYY-MM-DD` through 2026-08-05 and `M/D/YYYY`
 * (e.g. `7/1/2026`) from 2026-08-06. **The format is not cosmetic here** — a raw
 * `"7/1/2026"` sorts ABOVE every ISO date under the lexicographic `.sort()` that
 * picks the run's `asOf` (run-core.ts), so an un-normalized cell silently became
 * the run date and folded the whole dial at a bogus day (2026-08-06 incident).
 *
 * Accepts only those two shapes; anything else THROWS, so a third upstream format
 * degrades this feed loudly (the confirmer fetch is degrade-wrapped ⇒ EBP goes
 * non-live for the run) rather than leaking an unsortable string downstream.
 */
function toIsoEbpDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  throw new Error(`EBP CSV date is neither YYYY-MM-DD nor M/D/YYYY: ${raw}`);
}

/**
 * The EBP CSV is `date,gz_spread,ebp,est_prob` then `<date>,<gz>,<ebp>,<prob>`
 * monthly rows (first-of-month dates; `<date>` per `toIsoEbpDate` — the upstream
 * format is NOT stable). We resolve the `date` and `ebp` columns BY
 * HEADER NAME — not fixed indices — so a column reorder upstream can't silently
 * map us onto gz_spread or est_prob. Non-numeric / short rows are dropped.
 * @internal
 */
export function parseEbpCsv(csv: string): Observation[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const dateCol = header.indexOf("date");
  const ebpCol = header.indexOf("ebp");
  if (dateCol === -1 || ebpCol === -1) {
    throw new Error(`EBP CSV header missing date/ebp column: ${lines[0]}`);
  }

  const observations: Observation[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split(",");
    const date = cells[dateCol]?.trim();
    const raw = cells[ebpCol]?.trim();
    if (!date || raw === undefined || raw === "" || raw === ".") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    observations.push({ date: toIsoEbpDate(date), value });
  }

  return observations;
}
