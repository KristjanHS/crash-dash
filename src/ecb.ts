/**
 * Data layer: fetch + parse ECB SDMX-CSV series (no API key). The euro AAA
 * spot-rate curve (SR_10Y, SR_3M, dataflow `YC`) feeds the Euro-curve rates leg
 * (design §7); the ESTR overnight rate (dataflow `EST`, keyless HTTP 200 2026-09-24) feeds ESTR, and
 * with the SR_1Y tenor feeds EPATH (SR_1Y − ESTR);
 * the euro-area composite CISS (dataflow `CISS`, keyless HTTP 200 2026-09-24) feeds ECISS.
 * Mirrors fred.ts: one function behind the feed so a later swap is a single edit, a bounded trailing window (not full history), an explicit
 * UA + timeout, and a non-OK throw. Keyless, LIVE-VERIFIED HTTP 200 (`YC`
 * 2026-07-12).
 *
 * The SDMX endpoint's `data-api.ecb.europa.eu/service/data/<dataflow>/...` CSV keeps a full
 * header row EVEN with `detail=dataonly` (`KEY,FREQ,...,TIME_PERIOD,OBS_VALUE`), so
 * we locate `TIME_PERIOD`+`OBS_VALUE` BY COLUMN NAME (like a daily-close CSV parser's
 * header-index lookup, prices.ts) rather than by position. Values are percent
 * decimals (e.g. 3.0569). Sorted oldest→newest.
 */

import type { Observation } from "./domain-types.js";
import { VELOCITY_WINDOW, CONFIRM_CLOSES } from "./domain-types.js";
import { EPATH_DESCRIPTOR, ESTR_DESCRIPTOR, EURGBP_DESCRIPTOR } from "./family-descriptor-rows.js";
import { errMsg } from "./err-msg.js";
import { runBudgetExhausted } from "./fetch-budget.js";
import { type FetchLike, fetchText, HttpStatusError } from "./feed-http.js";

// The SDMX service root. The DATAFLOW (`YC`, …) is NOT part of it — it
// rides on each SERIES_KEYS entry, so a new ECB dataflow is one table row rather
// than a second base constant plus a branch (ruled 2026-07-30).
const ECB_SERVICE_BASE = "https://data-api.ecb.europa.eu/service/data";

// Each series we consume: its ECB `dataflow` + the `DATA_KEY` dimension suffix
// within that dataflow.
//   YC   — the AAA-rated euro spot-rate tenors (`...G_N_A.SV_C_YM.<tenor>`).
//   EST  — the ESTR overnight rate (volume-weighted trimmed mean, published T+1 ~08:00 CET).
//   CISS — the euro-area composite CISS, 0–1 (daily obs, released WEEKLY).
//   EXR  — the EUR/GBP euro foreign-exchange reference rate (GBP per EUR, TARGET days, ~16:00 CET).
const SERIES_KEYS = {
  SR_10Y: { dataflow: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y" },
  SR_3M: { dataflow: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M" },
  ESTR: { dataflow: "EST", key: "B.EU000A2X2A25.WT" },
  ECISS: { dataflow: "CISS", key: "D.U2.Z0Z.4F.EC.SS_CIN.IDX" },
  EURGBP: { dataflow: "EXR", key: "D.GBP.EUR.SP00.A" },
  // Spain 10y government bond yield, MONTHLY (IRS long-term convergence rate) — the BONOS source-drift probe's reference.
  ES10Y_M: { dataflow: "IRS", key: "M.ES.L.L40.CI.0000.EUR.N.Z" },
  // Cron feed: EPATH's policy-path leg (SR_1Y − ESTR, EPATH_DESCRIPTOR).
  SR_1Y: { dataflow: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_1Y" },
  // Study-only (the ESTR hike-side leg fit): the AAA 2y spot tenor and EONIA (dataflow EON, 1999-01 → 2021-12-31
  // discontinued), the pre-€STR overnight splice.
  SR_2Y: { dataflow: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y" },
  EONIA: { dataflow: "EON", key: "D.EONIA_TO.RATE" },
} as const;

export type EcbSeriesKey = keyof typeof SERIES_KEYS;

// Per-consumer scorer floors (EURC/ECISS velocity, ESTR's `change` window, EPATH's mean window, EURGBP's MA
// leg); ecb.test.ts scores each consumer at its OWN floor. Bounded trailing window = the MAX + a history buffer.
export const ECB_SCORER_FLOORS = {
  velocity: VELOCITY_WINDOW + 1 + CONFIRM_CLOSES,
  ESTR: ESTR_DESCRIPTOR.scorer.constants.window + CONFIRM_CLOSES,
  EPATH: VELOCITY_WINDOW + EPATH_DESCRIPTOR.meanWindow + CONFIRM_CLOSES,
  EURGBP: Math.max(VELOCITY_WINDOW, EURGBP_DESCRIPTOR.scorer.constants.maWindow - 1) + 1 + CONFIRM_CLOSES,
} as const;
export const ECB_LAST_N = Math.max(...Object.values(ECB_SCORER_FLOORS)) + 38;

// Per-attempt timeouts. A CDN-miss ECB answer is slow, not absent: ECB_TIMEOUT_MS must clear ECB_COLD_P100_MS; every
// retry busts the CDN cache key (`_=`; ECB ignores unknown params) — an independent cold request. 15 s × 2 [USER 2026-11-20].
// A `startPeriod` URL gets its own deep timeout and only ECB_DEEP_ATTEMPTS: the backfill runs 7 deep fetches serially.
/** Slowest cache-busted cold answer measured (curl TTFB, 2026-11-20). */
export const ECB_COLD_P100_MS = 10_900;
export const ECB_TIMEOUT_MS = 15_000;
export const ECB_DEEP_TIMEOUT_MS = 45_000;
export const ECB_MAX_ATTEMPTS = 2;
export const ECB_DEEP_ATTEMPTS = 2;
const ECB_RETRY_BACKOFF_MS = 250;

export function ecbTimeoutFor(opts?: { startPeriod?: string }): number {
  return opts?.startPeriod ? ECB_DEEP_TIMEOUT_MS : ECB_TIMEOUT_MS;
}

/**
 * `opts.startPeriod` (YYYY-MM-DD) swaps the bounded trailing window for a full
 * history from that date — sent INSTEAD of `lastNObservations` (SDMX rejects the
 * pair as contradictory). Additive: the production call sites pass nothing and
 * keep the ECB_LAST_N window verbatim. Used by the backfill CLI and probe scripts that
 * need the multi-thousand-day series the ECB_LAST_N window can't reach.
 * A timed-out/5xx attempt retries on a cache-busted URL (see ECB_TIMEOUT_MS); a 4xx throws at once.
 */
export async function fetchEcbSeries(
  seriesKey: EcbSeriesKey,
  opts?: { startPeriod?: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<unknown> },
): Promise<Observation[]> {
  const { dataflow, key: dataKey } = SERIES_KEYS[seriesKey];
  const params = new URLSearchParams({
    format: "csvdata",
    detail: "dataonly",
    ...(opts?.startPeriod ? { startPeriod: opts.startPeriod } : { lastNObservations: String(ECB_LAST_N) }),
  });
  // ECB, like FRED, can stall UA-less datacenter requests — send an explicit UA.
  // The timeout converts a hang into a fast retry; the run-wide deadline composed onto
  // it (fetch-budget.ts) caps the cycle's whole fetch phase.
  const csv = await fetchText(`${ECB_SERVICE_BASE}/${dataflow}/${dataKey}?${params}`, {
    fetchImpl: opts?.fetchImpl,
    init: { headers: { "User-Agent": "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)" } },
    timeoutMs: ecbTimeoutFor(opts),
    label: `ECB fetch failed for ${seriesKey}`,
    retry: {
      attempts: opts?.startPeriod ? ECB_DEEP_ATTEMPTS : ECB_MAX_ATTEMPTS,
      backoffMs: ECB_RETRY_BACKOFF_MS,
      sleep: opts?.sleep,
      // A 4xx is a wrong key/param, not a stall — and nothing is left to retry into once the run deadline fired.
      retryOn: (err) => !(err instanceof HttpStatusError && err.status < 500) && !runBudgetExhausted(),
      // Attempt 1 keeps the stable (CDN-cacheable) URL; each retry gets its own cache key (see ECB_TIMEOUT_MS).
      // The random part keeps two processes' retries (intraday + EOD, both on attempt 2) on distinct cold requests.
      rewriteUrl: (u, i) => (i === 1 ? u : `${u}&_=${i}${Math.random().toString(36).slice(2, 8)}`),
      giveUp: (err, { attempts, elapsedMs }) =>
        new Error(`${seriesKey}: ${errMsg(err)} (gave up after ${attempts} attempt(s), ${(elapsedMs / 1000).toFixed(1)} s)`, {
          cause: err,
        }),
    },
  });
  return parseEcbCsv(csv);
}

/**
 * ECB SDMX-CSV: a header row naming the columns (order not contractual), then one
 * row per observation. We locate `TIME_PERIOD` (the date) + `OBS_VALUE` (the rate)
 * by NAME, drop any row whose OBS_VALUE is non-numeric / "." / empty (Number("")
 * === 0 is finite — the same spurious-0 trap fred.ts guards), and sort
 * oldest→newest (the endpoint's `lastNObservations` returns newest-first).
 */
export function parseEcbCsv(csv: string): Observation[] {
  const lines = csv.trim().split("\n");
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const dateIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  const observations: Observation[] = [];

  if (dateIdx !== -1 && valueIdx !== -1) {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(",");
      const date = cols[dateIdx]?.trim();
      const raw = cols[valueIdx]?.trim();
      if (!date || raw === undefined) continue;
      const value = Number(raw);
      // Drop a missing observation: "." OR an empty field. Number("") === 0 is
      // finite, so without this it injects a spurious 0 (corrupting the 20d
      // velocity window downstream), not a dropped row.
      if (raw === "" || raw === "." || !Number.isFinite(value)) continue;
      observations.push({ date, value });
    }
  }

  observations.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return observations;
}
