/**
 * Data layer: keyless Fed GSW (Gurkaynak–Sack–Wright, feds200628) Svensson-parameter feed →
 * the Engstrom–Sharpe near-term forward spread legs (R8 Stage B).
 * One function behind the feed,
 * mirroring fred.ts (v4 §9).
 *
 * The CSV publishes only INTEGER-maturity zero yields (SVENY01…), so z(1.5)/z(1.75) are computed
 * from the BETA0–BETA3/TAU1/TAU2 params via the Svensson formula (continuously compounded;
 * `svenssonZero` cross-checked against published SVENY01/SVENY02 in gsw.test.ts).
 * Per date: `fwd = (1.75·z(1.75) − 1.5·z(1.5)) / 0.25`, then `NTFS = fwd − DGS3MO` (FRED),
 * inner-joined per date — the legs mix vintages up to ~1wk, so a date missing either leg drops.
 *
 * Full ~16MB fetch per run, no Range/cache seam; fail LOUD on fetch/parse (exact GSW only, no
 * FRED THREEFY fallback) — both ruled [USER] 2026-08-13. A broken feed surfaces as a stale
 * indicator, like every single-source feed.
 */

import { observationsByDate, type Observation } from "./domain-types.js";
import type { FeedPorts } from "./feed-ports.js";
import * as fred from "./fred.js";
import { alignByDate } from "./scorers-core.js";
import { type FetchLike, fetchText } from "./feed-http.js";
import type { Env } from "./config.js";

const GSW_CSV_URL = "https://www.federalreserve.gov/data/yield-curve-tables/feds200628.csv";
const UA = "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)";
// ~16MB body — double fred.ts's 15s; still composed with the run-wide budget (feed-http.ts).
const GSW_FETCH_TIMEOUT_MS = 30_000;

export interface SvenssonParams {
  b0: number;
  b1: number;
  b2: number;
  b3: number;
  t1: number;
  t2: number;
}

/** Svensson zero-coupon yield z(m), m in years, continuously compounded (GSW eq. 22). @internal */
export function svenssonZero(p: SvenssonParams, m: number): number {
  const term = (tau: number): number => (1 - Math.exp(-m / tau)) / (m / tau);
  return (
    p.b0 +
    p.b1 * term(p.t1) +
    p.b2 * (term(p.t1) - Math.exp(-m / p.t1)) +
    p.b3 * (term(p.t2) - Math.exp(-m / p.t2))
  );
}

/** The near-term forward leg: the implied 1.5y→1.75y forward rate off one date's params. @internal */
export function nearTermForward(p: SvenssonParams): number {
  return (1.75 * svenssonZero(p, 1.75) - 1.5 * svenssonZero(p, 1.5)) / 0.25;
}

// The param columns a usable row needs. Early rows publish TAU2 as a -999.99 sentinel with
// BETA3 = 0 — the τ2 term multiplies to 0, so the sentinel needs no special case.
const GSW_PARAM_COLUMNS = ["BETA0", "BETA1", "BETA2", "BETA3", "TAU1", "TAU2"] as const;

/**
 * feds200628 CSV → per-date `fwd` observations (oldest→newest, dedup last-wins like
 * parseFredCsv). The file opens with a quoted staff-note preamble + a mnemonic table before the
 * `Date,BETA0,…` header — locate the header line, then the param columns BY NAME. Throws on a
 * missing header/column or zero parseable rows (fail-loud ruling above); rows with NA params or
 * a non-finite fwd are skipped.
 * @internal
 */
export function parseGswCsv(csv: string): Observation[] {
  const lines = csv.split("\n");
  const headerIdx = lines.findIndex((l) => /^Date,/.test(l.trim()));
  if (headerIdx === -1) {
    throw new Error(`GSW feds200628: no "Date,…" header line found (format drift?): ${csv.slice(0, 120)}`);
  }
  const header = lines[headerIdx]!.trim().split(",");
  const col: Record<string, number> = {};
  for (const name of GSW_PARAM_COLUMNS) {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`GSW feds200628: header lacks column ${name}`);
    col[name] = idx;
  }

  const byDate = new Map<string, number>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const cells = line.split(",");
    const date = cells[0];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // Number("") === 0 — an empty param cell must skip like NA, never coerce to 0 (fred.ts trap).
    if (GSW_PARAM_COLUMNS.some((name) => !cells[col[name]!]?.trim())) continue;
    const p = {
      b0: Number(cells[col["BETA0"]!]),
      b1: Number(cells[col["BETA1"]!]),
      b2: Number(cells[col["BETA2"]!]),
      b3: Number(cells[col["BETA3"]!]),
      t1: Number(cells[col["TAU1"]!]),
      t2: Number(cells[col["TAU2"]!]),
    };
    if (Object.values(p).some((v) => !Number.isFinite(v))) continue;
    const fwd = nearTermForward(p);
    if (!Number.isFinite(fwd)) continue;
    byDate.set(date, fwd);
  }
  if (byDate.size === 0) {
    throw new Error("GSW feds200628: 0 parseable parameter rows");
  }
  return observationsByDate(byDate);
}

/** Full-history `fwd` series off the live CSV. Throws on non-OK / parse failure — never imputes. @internal */
export async function fetchGswForward({ fetchImpl }: { fetchImpl?: FetchLike } = {}): Promise<Observation[]> {
  const csv = await fetchText(GSW_CSV_URL, {
    fetchImpl,
    init: { headers: { "User-Agent": UA } },
    timeoutMs: GSW_FETCH_TIMEOUT_MS,
    label: "GSW feds200628 fetch failed",
  });
  return parseGswCsv(csv);
}

/** NTFS = fwd − DGS3MO, inner-joined per date (a date missing either leg drops). @internal */
export function ntfsFromLegs(fwd: Observation[], dgs3mo: Observation[]): Observation[] {
  const { dates, a, b } = alignByDate(fwd, dgs3mo);
  return dates.map((date, i) => ({ date, value: a[i]! - b[i]! }));
}

/**
 * The NTFS series, full history (the GSW leg is always the whole file, so the DGS3MO leg
 * matches it) — the feed builder `indicator-feed.ts` dispatches an `FEED_OF` "ntfs" id onto.
 */
export async function fetchNtfsSeries(now: Date, env: Env, feeds: Pick<FeedPorts, "fetchSeries"> = { fetchSeries: (...a) => fred.fetchSeries(...a) }): Promise<Observation[]> {
  const [fwd, dgs3mo] = await Promise.all([fetchGswForward(), feeds.fetchSeries("DGS3MO", { fullHistory: true, now, env })]);
  return ntfsFromLegs(fwd, dgs3mo);
}
