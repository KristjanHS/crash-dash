/**
 * Data layer: fetch + parse the Bundesbank BBSIS daily Federal-securities spot-rate
 * series (no API key). The 10y and 2y tenors are the BUND probes' curve (`scripts/probe-bund-*.ts`).
 * Mirrors ecb.ts: one IO function behind the feed so a later
 * swap is a single edit, a bounded trailing window, an explicit UA + timeout, and a
 * non-OK throw. Keyless, LIVE-VERIFIED HTTP 200 through `fetchBundYield` (2026-08-08):
 * 7,361 PARSED observations per tenor, 1997-08-07 → 2026-08-07. The file itself carries
 * 10,599 dated rows — the difference is holiday rows the parser drops, so never compare a
 * raw line count against an observation count.
 *
 * We read the `api.statistiken.bundesbank.de` statistics-portal export. Two prior shapes
 * are retired, and BOTH failure modes are worth knowing:
 *
 *   1. This module shipped against this same API host on 2026-07-18, then left it on
 *      2026-07-25 because it had been placed behind an "Enodia" JS proof-of-work bot
 *      challenge (every path answering `303 → /.enodia/challenge`, an HTML page with
 *      status 400, so `fetch` hit `!res.ok`). It has since cycled on→off→on→off (lifted by
 *      2026-08-08; back and gone again within 2026-09-01) — TRANSIENT: re-probe, never re-point.
 *   2. It then read the `www.bundesbank.de/statistic-rmi/StatisticDownload` LEGACY
 *      time-series-database export, which the Bundesbank decommissioned (shutdown
 *      announced 30 June 2026, everything migrated to this portal). That URL still
 *      answers **HTTP 200 with a complete-looking full history** — it simply stopped
 *      being extended after 2026-08-03. Neither `!res.ok` nor the zero-row throw below
 *      can see that: the `BUND_MAX_STALE_DAYS` throw on the newest observation's age does.
 *
 * `/rest/download/…` + `lang=en` are BOTH load-bearing. `/rest/data/<flow>/<key>` returns
 * the German rendering — semicolon-delimited, comma decimals (`2026-08-04;3,22;`), flag
 * text `Kein Wert vorhanden` — which this parser drops wholesale → the zero-row throw.
 * That is the same trap the retired legacy `its_csvFormat=en` parameter guarded,
 * reappearing under a new spelling. Same-date values agree across hosts (2026-08-03 reads
 * 3.21 / 2.75 on both), so the swap splices nothing: stored history stays homogeneous.
 *
 * The endpoint is plain CSV — `date,value,flag` — behind a BOM'd metadata preamble. It
 * has NO `lastN` parameter, so the trailing window is applied AFTER parse, unlike
 * ecb.ts's server-side `lastNObservations`. Values are percent decimals (e.g. 3.20).
 * Sorted oldest→newest.
 *
 * Do NOT re-point on a challenge before re-probing: the ECB `YC` substitute is the AAA
 * composite, whose slope ran above the Bund's on 2024+ and flipped 5.8% of days' states against the level
 * cuts of that era, every one UNDERSTATING danger (measured).
 */

import type { Observation } from "./domain-types.js";
import { VELOCITY_WINDOW, CONFIRM_CLOSES, observationsByDate } from "./domain-types.js";
import { type FetchLike, fetchText } from "./feed-http.js";

// The `BBSIS` flow is the last PATH segment — the key below is appended to it. On the
// retired legacy export the flow was instead a `BBSIS.` prefix inside the `tsId` query
// parameter; that is the one shape difference between the two hosts' keys.
const BUNDESBANK_BASE = "https://api.statistiken.bundesbank.de/rest/download/BBSIS";

// The two tenors we consume, keyed by our series key → the BBSIS maturity token. The
// keys differ ONLY in `R10XX` / `R02XX`; everything else is the same Svensson curve.
const SERIES_KEYS = {
  Y10: "D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A",
  Y02: "D.I.ZST.ZI.EUR.S1311.B.A604.R02XX.R.A.A._Z._Z.A",
} as const;

export type BundMaturity = keyof typeof SERIES_KEYS;

// A BARE call's trailing window (ECB_LAST_N's old expression), sliced post-parse off the full-history file; ⚠ too
// short for `scoreBundCurve`'s leg (c) (`bundLegHead()` obs), so every scorer caller passes `sinceDate`.
const BUND_TAIL = VELOCITY_WINDOW + CONFIRM_CLOSES + 38;

// Hand-set with headroom over a business-daily feed's longest holiday gap; past it the fetch throws.
export const BUND_MAX_STALE_DAYS = 10;

/**
 * The download URL for one tenor. Exported so `scripts/probe-bund-*.ts` — which need the
 * full ~7,400-observation history the BUND_TAIL slice discards, and so call `fetch` themselves —
 * share ONE definition with production. They previously each inlined their own copy, and
 * all three rotted together when the REST host went behind the bot challenge; sharing one
 * definition is why the 2026-08-08 legacy-decommission swap was a single-site edit.
 */
export function bundesbankCsvUrl(maturity: BundMaturity): string {
  const params = new URLSearchParams({
    format: "csv",
    lang: "en", // dot decimals + comma delimiter — see the docblock; `de` breaks the parse
  });
  return `${BUNDESBANK_BASE}/${SERIES_KEYS[maturity]}?${params}`;
}

/**
 * `opts.sinceDate` (YYYY-MM-DD) swaps the bounded `BUND_TAIL` slice for every observation on
 * or after that date — the endpoint already returns full history, so this is a wider slice,
 * not a second request. Every production caller passes it (the run path, `scripts/backfill.ts`, the probes):
 * the bare BUND_TAIL slice cannot cover `scoreBundCurve`'s leg-(c) lookback.
 *
 * The 2026-08-08 host swap left both paths unchanged: the portal export is also full history
 * (10,599 dated rows vs the legacy export's 10,595 through 2026-08-03), sorted ascending, so
 * the trailing slice and the `sinceDate` filter behave identically on it. Verified live —
 * `sinceDate: "1997-01-01"` returns 7,361 observations, the bare call exactly BUND_TAIL (60).
 */
export async function fetchBundYield(
  maturity: BundMaturity,
  opts: { sinceDate?: string; now: string; fetchImpl?: FetchLike },
): Promise<Observation[]> {
  const url = bundesbankCsvUrl(maturity);
  // Bundesbank, like FRED and the ECB, can stall UA-less datacenter requests — send an
  // explicit UA. The timeout converts a hang into a fast, logged failure; the run-wide
  // deadline composed onto it (fetch-budget.ts) caps the cycle's whole fetch phase.
  const text = await fetchText(url, {
    fetchImpl: opts.fetchImpl,
    init: { headers: { "User-Agent": "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)" } },
    timeoutMs: 15_000,
    label: `Bundesbank fetch failed for ${maturity}`,
    // `res.url` is the FINAL url: the challenge's `303` is followed, so a bare `res.status`
    // reads 400 and mis-blames the request or the series key. Name the challenge instead.
    statusMessage: (res) =>
      res.url.includes("/.enodia/")
        ? `Bundesbank fetch blocked for ${maturity}: the statistics portal is behind the Enodia ` +
          `bot challenge (303 -> /.enodia/challenge, page status ${res.status}), not a request ` +
          `or series-key fault - see bundesbank.ts, failure mode 1.`
        : `Bundesbank fetch failed for ${maturity}: ${res.status} ${res.statusText}`,
  });
  const observations = parseBundesbankCsv(text);
  // Zero rows ⇒ throw, never impute (mirrors parseCapeTable). A silently
  // empty series would blind the scorer's `latest()` guard rather than degrade loudly.
  if (observations.length === 0) {
    throw new Error(`Bundesbank returned zero parsable observations for ${maturity}`);
  }
  // Failure mode 2 (dead-but-200): a full history that stopped extending passes both throws above.
  const newest = observations[observations.length - 1]!.date;
  const now = opts.now;
  const ageDays = Math.round((Date.parse(now) - Date.parse(newest)) / 86_400_000);
  if (ageDays > BUND_MAX_STALE_DAYS) {
    throw new Error(
      `Bundesbank feed stale for ${maturity}: newest observation ${newest} is ${ageDays}d old ` +
        `(> ${BUND_MAX_STALE_DAYS}d) - see bundesbank.ts, failure mode 2.`,
    );
  }
  const sinceDate = opts.sinceDate;
  return sinceDate ? observations.filter((o) => o.date >= sinceDate) : observations.slice(-BUND_TAIL);
}

/**
 * Bundesbank BBSIS CSV: a ~9-line metadata preamble, then `date,value,flag` rows.
 *
 * The preamble is skipped BY SHAPE — we keep only lines whose first field is a
 * `YYYY-MM-DD` date — never by line count: a preamble length change would otherwise
 * silently eat leading observations. Holiday rows carry `.` (flag "No value available")
 * and are dropped, as is an empty value field: `Number("") === 0` is finite, the same
 * spurious-0 trap fred.ts and ecb.ts both guard by name, and a leaked 0 would corrupt the
 * 20d velocity window downstream. Sorted ascending and deduped by date (last wins),
 * matching parseFredCsv's guarantees.
 */
export function parseBundesbankCsv(text: string): Observation[] {
  const byDate = new Map<string, number>();

  for (const rawLine of text.split("\n")) {
    // Trim per line: `\r\n` endings are unverified for this endpoint, so don't assume.
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(",");
    const date = cols[0]?.trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // preamble / stray line
    const raw = cols[1]?.trim().replace(/^"|"$/g, "");
    if (!raw || raw === "." || raw === "No value available") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    byDate.set(date, value);
  }

  return observationsByDate(byDate);
}
