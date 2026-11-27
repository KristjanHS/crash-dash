// Loader for the HY-OAS full-history vintage CSV (data/BAMLH0A0HYM2-vintage.csv, provenance:
// data/README.md). OPTIONAL: a checkout without the file loads `undefined` and the read handlers
// degrade (api/lab.ts, api/replay.ts). Fail-loud otherwise: any structural anomaly in a PRESENT
// file throws — a silently short or corrupt vintage would poison every episode replay built on it.
import { readFileSync } from "node:fs";
import { dropWeekendMarks } from "./ice-weekend-marks.js";
import type { Observation } from "./domain-types.js";

// new URL(…, import.meta.url) is the form Vercel's nft tracer follows to bundle the asset
// into the fn (fallback if the e2e stage proves the trace misses: vercel.json includeFiles).
const VINTAGE_SERIES = "BAMLH0A0HYM2";
const VINTAGE_URL = new URL(`../data/${VINTAGE_SERIES}-vintage.csv`, import.meta.url);
const EXPECTED_FIRST_DATE = "1996-12-31";
const MIN_ROWS = 7000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse + validate vintage CSV text. Exported as a seam so tests never touch data/. */
export function parseVintageCsv(
  text: string,
  checks: { firstDate?: string; minRows?: number } = {},
): Observation[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines[0] !== "date,value") throw new Error(`vintage CSV: bad header "${lines[0]}"`);
  const observations: Observation[] = [];
  for (const line of lines.slice(1)) {
    const [date, raw, ...rest] = line.split(",");
    if (date === undefined || raw === undefined || rest.length > 0) {
      throw new Error(`vintage CSV: malformed row "${line}"`);
    }
    if (!ISO_DATE_RE.test(date)) throw new Error(`vintage CSV: non-ISO date "${date}"`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 30) {
      throw new Error(`vintage CSV: out-of-range value "${raw}" on ${date}`);
    }
    const prev = observations[observations.length - 1];
    if (prev && prev.date >= date) {
      throw new Error(`vintage CSV: dates not ascending at ${date} (after ${prev.date})`);
    }
    observations.push({ date, value });
  }
  if (checks.firstDate !== undefined && observations[0]?.date !== checks.firstDate) {
    throw new Error(
      `vintage CSV: first date ${observations[0]?.date ?? "(none)"} ≠ ${checks.firstDate}`,
    );
  }
  if (checks.minRows !== undefined && observations.length < checks.minRows) {
    throw new Error(`vintage CSV: only ${observations.length} rows (< ${checks.minRows})`);
  }
  return observations;
}

/** The file's text, or `undefined` when it is ABSENT (ENOENT — the only swallowed error; any other read
 *  failure throws). `url` is the test seam for the absent path. */
export function readVintageText(url: URL = VINTAGE_URL): string | undefined {
  try {
    return readFileSync(url, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** For a caller that cannot run without the vintage (backfill, backtests, probes): the observations, or a
 *  throw naming the missing file. */
export function requireVintage(obs: Observation[] | undefined): Observation[] {
  if (obs === undefined) throw new Error(`HY-OAS vintage CSV absent: ${VINTAGE_URL.pathname} is not in this checkout`);
  return obs;
}

// Per-process memos; `null` = the file is absent (memoized like a load).
let asFiled: Observation[] | null | undefined;
let cached: Observation[] | null | undefined;

/** The vintage exactly as filed — ICE BofA weekend month-end marks INCLUDED; `undefined` when the file is
 *  absent. Only for an artifact pinned to it: `scripts/backtest/f1-percentile-cuts.ts`'s committed
 *  `f1_cuts.json` was measured over these rows, so re-measuring on trading closes is a cut move
 *  (indicator-cut-provenance.md), not a reader fix. */
export function loadHyOasVintageAsFiled(): Observation[] | undefined {
  if (asFiled === undefined) {
    const text = readVintageText();
    asFiled = text === undefined ? null : parseVintageCsv(text, { firstDate: EXPECTED_FIRST_DATE, minRows: MIN_ROWS });
  }
  return asFiled === null ? undefined : asFiled;
}

/** Read + validate the vintage file, cached per process (read once per lambda), with the ICE BofA weekend
 *  month-end marks dropped (`dropWeekendMarks`) — so the `/api/replay` + `/lab?replay` stitch and the backfill
 *  archive (`FRED_ARCHIVE`) read trading closes only, as the live feed (src/fred.ts) does. `undefined` when the
 *  file is absent. */
export function loadHyOasVintage(): Observation[] | undefined {
  if (cached === undefined) {
    const filed = loadHyOasVintageAsFiled();
    cached = filed === undefined ? null : dropWeekendMarks(VINTAGE_SERIES, filed);
  }
  return cached === null ? undefined : cached;
}
