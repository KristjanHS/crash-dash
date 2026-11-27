/**
 * Standing falsifier that the Treasury same-day HEAD still equals FRED's T+1 print — the guard S2's
 * graft relies on. For EVERY column in
 * `TREASURY_HEAD_OF` it fetches the last ~40 business days from BOTH feeds — FRED via `fetchSeries`,
 * Treasury via `fetchTreasuryColumn` — and diffs them on the SHARED dates with the same STRICT equality
 * the graft's own gate uses (`graftTreasuryHead`, treasury.ts: `mine !== row.value`).
 *
 *   npm run probe:rate-feed-parity          # keyless read-only fetch, no stack, no env file
 *
 * The FRED series id per column is derived from the REGISTRY (`fredLoopIndicator(id).series`), never a
 * `"DGS10"` literal restated here — one touch point, per the repo's threshold discipline.
 *
 * A3 January fallback (mirrors `graftTreasuryHeadFor`, indicator-feed.ts): the Treasury CSV is per-year, so
 * in early January the current-year column's FRED overlap (current-year rows at or before FRED's last obs)
 * falls under `MIN_OVERLAP_ROWS`. When it does — and only then — the probe ALSO fetches `year - 1` and
 * concatenates before diffing, so the verdict tracks the RUNTIME's behaviour rather than red-alarming a
 * state the code handles.
 *
 * Three verdicts (exit 1 on any non-PARITY column — a falsifier that cannot ESTABLISH is not green):
 *   PARITY        — ≥ MIN_OVERLAP_ROWS shared dates, all byte-identical.
 *   MISMATCH      — a shared date whose two feeds disagree: the equality the graft trusts has drifted.
 *   INDETERMINATE — fewer than MIN_OVERLAP_ROWS shared dates even AFTER the A3 fallback (a feed outage, no
 *                   longer the January boundary — the fallback now covers that): parity was not proven.
 *
 * `startTreasuryMemo`/`stopTreasuryMemo` bracket the run so the two nominal columns (R2, R3) share one
 * CSV fetch. Read-only: it never writes.
 */
import type { Observation } from "../src/domain-types.js";
import { TREASURY_HEAD_OF } from "../src/registry-fred.js";
import { fredLoopIndicator } from "../src/confirmers.js";
import { realFeeds } from "../src/feed-ports.js";
import { sinceDaysAgo } from "../src/lookback.js";
import { fetchTreasuryColumn, MIN_OVERLAP_ROWS, startTreasuryMemo, stopTreasuryMemo } from "../src/treasury.js";
import { readEnv } from "../src/config.js";

/** ~40 business days of shared overlap — comfortably above `MIN_OVERLAP_ROWS` outside early January. */
const LOOKBACK_DAYS = 60;

export interface ColumnDiff {
  shared: number;
  mismatches: Array<{ date: string; fred: number; treasury: number }>;
}

/**
 * Pure comparison of two feeds on their SHARED dates — the CAN-fail seam the probe is built on. Distinct
 * dates only (a duplicate-dated row never inflates the count, mirroring `graftTreasuryHead`), STRICT
 * equality (the graft drops a head on any `!==`, so the guard must too).
 */
export function diffColumn(fred: Observation[], treasury: Observation[]): ColumnDiff {
  const fredValue = new Map(fred.map((o) => [o.date, o.value]));
  const seen = new Set<string>();
  const mismatches: ColumnDiff["mismatches"] = [];
  for (const row of treasury) {
    const mine = fredValue.get(row.date);
    if (mine === undefined || seen.has(row.date)) continue;
    seen.add(row.date);
    if (mine !== row.value) mismatches.push({ date: row.date, fred: mine, treasury: row.value });
  }
  return { shared: seen.size, mismatches };
}

export type Verdict = "PARITY" | "MISMATCH" | "INDETERMINATE";

export function verdictFor(d: ColumnDiff): Verdict {
  if (d.mismatches.length > 0) return "MISMATCH";
  if (d.shared < MIN_OVERLAP_ROWS) return "INDETERMINATE";
  return "PARITY";
}

/**
 * `diffColumn` with A3's January fallback — the same predicate `graftTreasuryHeadFor` (indicator-feed.ts)
 * uses. Count the current-year rows whose date is at or before FRED's last obs (the OVERLAP, NOT the raw
 * row count — a head row dated after FRED never counts) and, only when that is `< MIN_OVERLAP_ROWS`, ALSO
 * fetch `year - 1` and concatenate (prior year first) before diffing. One extra fetch, and only when thin —
 * never unconditionally; an empty FRED history can't be grafted onto, so skip the extra fetch there too.
 */
export async function diffColumnWithFallback(
  fred: Observation[],
  fetchColumn: (year: number) => Promise<Observation[]>,
  year: number,
): Promise<ColumnDiff> {
  let treasury = await fetchColumn(year);
  const lastFred = fred.reduce((max, o) => (o.date > max ? o.date : max), "");
  const overlap = treasury.reduce((n, r) => (r.date <= lastFred ? n + 1 : n), 0);
  if (fred.length > 0 && overlap < MIN_OVERLAP_ROWS) {
    treasury = [...(await fetchColumn(year - 1)), ...treasury];
  }
  return diffColumn(fred, treasury);
}

async function main(): Promise<void> {
  const env = readEnv();
  const year = new Date().getUTCFullYear();
  const since = sinceDaysAgo(LOOKBACK_DAYS, new Date());
  let failures = 0;

  startTreasuryMemo();
  try {
    for (const [id, head] of Object.entries(TREASURY_HEAD_OF)) {
      const series = fredLoopIndicator(id).series;
      let diff: ColumnDiff | undefined;
      let err: unknown;
      try {
        const fred = await realFeeds.fetchSeries(series, { since, now: new Date(), env });
        diff = await diffColumnWithFallback(
          fred,
          (y) => fetchTreasuryColumn(head.curve, head.column, y),
          year,
        );
      } catch (e) {
        err = e;
      }

      const label = `${id} ${head.curve}/"${head.column}" ≡ ${series}`;
      if (diff === undefined) {
        failures++;
        console.log(`${label}\n  BLOCK-ERROR ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const verdict = verdictFor(diff);
      if (verdict !== "PARITY") failures++;
      console.log(`${label}\n  shared=${diff.shared} mismatched=${diff.mismatches.length} → ${verdict}`);
      for (const m of diff.mismatches) console.log(`    ${m.date} fred=${m.fred} treasury=${m.treasury}`);
    }
  } finally {
    stopTreasuryMemo();
  }

  const verdict = failures === 0 ? "PASS" : "FAIL";
  console.log(`VERDICT: ${verdict} (non-parity columns=${failures})`);
  if (failures > 0) process.exitCode = 1;
}

const isDirect = process.argv[1]?.endsWith("probe-rate-feed-parity.ts") === true;
if (isDirect) {
  await main();
}
