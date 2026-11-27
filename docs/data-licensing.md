# Data licensing

Where the data this repository's code reads comes from, what it fetches, what it stores, and how to
credit each provider. Scope: **the code in this repository** (`src/`, `api/`). It describes
what that code does, not any particular deployment of it; anyone running it is responsible for checking
each provider's terms for their own use. Nothing here restates or interprets a licence: follow the
link and read the provider's terms.

## Sources the run cycle fetches

Every data fetch goes through one module per source; the run cycle reaches them through
`src/feed-ports.ts` (`realFeeds`), except `resolveBreadthCloses` (`src/run-dbfirst.ts`), whose default
shallow price read calls `src/prices.ts` `fetchDailyCloses` directly.

| Source | What is fetched | Module · endpoint host | API key |
|---|---|---|---|
| FRED (Federal Reserve Bank of St. Louis) | Daily/weekly/monthly economic series by id (rates, spreads, oil, financial-conditions indices) | `src/fred.ts` · `api.stlouisfed.org` (keyed) or `fred.stlouisfed.org` CSV (keyless fallback) | Optional: `FRED_API_KEY`. Without it the keyless CSV endpoint is used |
| Federal Reserve Board: Excess Bond Premium | Monthly EBP CSV, full history | `src/ebp.ts` · `www.federalreserve.gov` | None |
| Federal Reserve Board: GSW yield-curve parameters | `feds200628.csv` (Svensson parameters), used to compute a near-term forward spread | `src/gsw.ts` · `www.federalreserve.gov` | None |
| European Central Bank Data Portal | SDMX-CSV series: euro AAA spot-rate curve, €STR, euro-area CISS (bounded trailing window) | `src/ecb.ts` · `data-api.ecb.europa.eu` | None |
| U.S. Department of the Treasury | Daily nominal and real yield-curve CSVs: a same-day value for rate series FRED publishes a day later | `src/treasury.ts` · `home.treasury.gov` | None |

Research probes only (`scripts/probe-bund-*.ts`, not the scheduled run): the Deutsche Bundesbank
statistics API (`api.statistiken.bundesbank.de`, `src/bundesbank.ts`), keyless.

The FRED, Federal Reserve, ECB and Bundesbank requests send a `User-Agent` naming this repository.

## Outbound services (notifications, not data)

| Service | Use | Module | Key |
|---|---|---|---|
| ntfy (`ntfy.sh`) | Push notification of the alert band | `src/ntfy.ts` | `NTFY_TOPIC` (the topic name is the shared secret) |
| Brevo | Optional email of the same push to subscribers | `src/email.ts` | `BREVO_API_KEY` |

## What is stored

Persistence is Supabase Postgres; the schema lives only in `supabase/migrations/`.

- **`readings`**: one row per indicator per observation date per run: `value` (the indicator's level),
  `delta20` (20-trading-day change), the Green/Amber/Red `raw_state`/`state`, and later-added derived
  columns. For an indicator built on one source series, `value` **is** that series' observation; for a
  composite (a spread, ratio or model output) it is the computed number.
- **`alert_log`**: one row per run: the derived verdict (alert level, scores, band, held leg, panel and
  dial state). Its `run_inputs` JSON column carries per-indicator input values not derivable from `readings`.
- **Retention**: `src/retention.ts` `retainable()` decides which indicator ids may be stored. Today it
  returns `true` for every id, so every fetched indicator's rows are kept.
- Raw source files (CSV/JSON responses) are parsed in memory and not stored as files.

## Committed data files

Tabular and backtest data files committed to this repository are either seeded synthetic fixtures or
on a short allowlist of US-government / Federal Reserve public-domain series and the project's own
config. `scripts/committed-data.test.ts` enforces this on every test run. Derived-statistics files such as
`scripts/backtest/f1_cuts.json` carry numbers computed from a series (percentile cuts, plus the row counts
and date spans of its inputs on the file's `generated` date), never the series' rows.

## Attribution

| Provider | Credit line | Terms |
|---|---|---|
| FRED | Source: Federal Reserve Bank of St. Louis, FRED, plus the original source FRED names on each series page | See the provider's terms: <https://fred.stlouisfed.org/> |
| Federal Reserve Board | Source: Board of Governors of the Federal Reserve System | See the provider's terms: <https://www.federalreserve.gov/> |
| ECB | Source: European Central Bank Data Portal | See the provider's terms: <https://www.ecb.europa.eu/> |
| U.S. Treasury | Source: U.S. Department of the Treasury | See the provider's terms: <https://home.treasury.gov/> |
| Deutsche Bundesbank (probes only) | Source: Deutsche Bundesbank | See the provider's terms: <https://www.bundesbank.de/> |

FRED re-publishes series owned by many third parties, and some owners bar redistribution. Those ids
are listed in `src/fred-series-policy.ts` (`REFUSED_SERIES`); `fetchSeries` refuses them before any
request, so the run cycle never requests them from FRED. The one exception on the read side is the
optional local vintage file below.

## Optional local vintage file

`data/BAMLH0A0HYM2-vintage.csv` is a full-history vintage of FRED series `BAMLH0A0HYM2` (`date,value`).
It is not committed; `npx tsx scripts/fetch-hyoas-vintage.ts` builds it locally from a public web-archive
capture of the series' FRED page. When present, `src/hyoas-vintage.ts` loads it for the read handlers
`api/replay.ts` and `api/lab.ts` (`?replay=`), which use it only once a stored `BAMLH0A0HYM2` tail exists to
stitch after it. `BAMLH0A0HYM2` is on `REFUSED_SERIES`, so this tree neither fetches nor stores it and no
tail exists (`refusedSeries` changes the set, README §Data sources and extension points). With no tail,
`/api/replay` serves empty episode `points`, and `/api/lab?replay=` notes "HY-OAS live tail unavailable"
and falls back to the stored F1 series; with no vintage file, both views degrade the same way. Its use is subject to the series owner's terms, as named on the
series' FRED page.

## What is not included

Some inputs have no free source wired into this code. Their fetch port throws `NoFreeSourceError`
(`src/no-free-source.ts`) before any request, and the caller degrades: the indicator is skipped or
falls back, and the miss is logged to the run's degrade trace instead of aborting the run. Today that
covers daily equity/ETF prices (`src/prices.ts`), hourly price bars, volatility-index closes, index
end-of-day closes, sovereign-yield bars and quotes, official 10-year yield legs, DRAM spot prices and the
CAPE history (`src/feed-ports.ts`), plus every `REFUSED_SERIES` id. Indicators that depend on them run
degraded, and the numbers they would contribute are absent.
