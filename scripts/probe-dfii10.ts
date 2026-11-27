/**
 * `npm run -s probe:dfii10 [-- --json]` — the semis `real_yield` sign's `measure`: keyless FRED DFII10 close and its Δ`ESC_REAL_DELTA_N`
 * against the box line `ESC_REAL_DELTA` (the vote's own `delta` arithmetic and `EPS`, `SEMIS_RULES`). `--json` prints a `Measured` reading.
 * FRED-only: no Treasury same-day head graft (`TREASURY_HEAD_OF`), so the close can trail the vote's `R4` read by a day.
 */
import { fileURLToPath } from "node:url";
import type { Observation } from "../src/domain-types.js";
import type { FetchLike } from "../src/fetch-budget.js";
import { realFeeds } from "../src/feed-ports.js";
import { delta } from "../src/ladder-jobs.js";
import type { Measured } from "../src/ladder-run.js";
import { SEMIS_RULES } from "./probe-semis-tranches.js";
import { EPS } from "./semis-series.js";

const SERIES = "DFII10";
/** Calendar days fetched — comfortably over ESC_REAL_DELTA_N (120) business-day observations. */
const LOOKBACK_DAYS = 300;
const { ESC_REAL_DELTA_N: N, ESC_REAL_DELTA: LINE } = SEMIS_RULES;

/** Percentage points → signed bp at 0.1 bp, the probe's own `bp` precision (a 74.96 never prints as the line). */
const bp = (pp: number): string => `${pp >= 0 ? "+" : "−"}${+Math.abs(pp * 100).toFixed(1)} bp`;
export const sourceUrl = (since: string): string => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${SERIES}&cosd=${since}`;

/** Latest close + Δ`N` (bp) vs the +`LINE` box line and its verdict; `{error}` short of N+1 observations. */
export function measureDfii10(obs: readonly Observation[], url: string): Measured {
  const d = delta(obs, N);
  if (d === null) return { error: `${SERIES}: ${obs.length} observations, need ${N + 1} for Δ${N}` };
  const last = obs.at(-1)!;
  return { asOf: last.date, text: `${SERIES} ${last.value.toFixed(2)} % close ${last.date.slice(5)} · Δ${N} ${bp(d)} vs ${bp(LINE)} line ${d >= LINE - EPS ? "≥ line" : "under line"}`, sources: [{ date: last.date, url }] };
}

export async function measure(now: Date, fetchImpl: FetchLike = fetch): Promise<Measured> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  // env {} pins the keyless CSV path, so the cited URL is the one that served.
  return measureDfii10(await realFeeds.fetchSeries(SERIES, { since, env: {}, now, fetchImpl }), sourceUrl(since));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = process.argv.includes("--json");
  let m: Measured;
  try {
    m = await measure(new Date());
  } catch (e) {
    m = { error: `${SERIES}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  console.log(json ? JSON.stringify(m) : "error" in m ? `probe:dfii10 — ${m.error}` : m.text);
}
