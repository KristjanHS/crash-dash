/**
 * `npm run -s probe:cftc-yen [-- --json]` — the semis `cftc_yen` sign's `measure`: keyless CFTC public-reporting Socrata, TFF Futures Only
 * (`gpe5-46if`), JPY CME (097741) leveraged-funds net = long − short, latest week and its w/w change. `--json` prints a `Measured` reading.
 */
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../src/fetch-budget.js";
import type { Measured } from "../src/ladder-run.js";

const CODE = "097741";
const MARKET = "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE";
export const QUERY_URL =
  "https://publicreporting.cftc.gov/resource/gpe5-46if.json?" +
  new URLSearchParams({
    $select: "report_date_as_yyyy_mm_dd,market_and_exchange_names,lev_money_positions_long,lev_money_positions_short",
    $where: `cftc_contract_market_code='${CODE}'`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "2",
  }).toString();
export type TffRow = { report_date_as_yyyy_mm_dd: string; market_and_exchange_names: string; lev_money_positions_long: string; lev_money_positions_short: string };

const fmt = (n: number, sign = false): string => `${n < 0 ? "−" : sign ? "+" : ""}${Math.abs(n).toLocaleString("en-US")}`;
const net = (r: TffRow): number => Number(r.lev_money_positions_long) - Number(r.lev_money_positions_short);

/** Rows newest-first → net + Δ w/w; `{error}` short of two JPY-CME weeks or on a non-numeric position. */
export function measureCftcYen(rows: readonly TffRow[], url: string): Measured {
  if (rows.length < 2) return { error: `CFTC TFF ${CODE}: ${rows.length} report(s), need 2 for Δ w/w` };
  const [now, prev] = rows as [TffRow, TffRow];
  if (rows.some((r) => r.market_and_exchange_names !== MARKET)) return { error: `CFTC TFF ${CODE}: market is not ${MARKET}` };
  const [a, b] = [net(now), net(prev)];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: `CFTC TFF ${CODE}: non-numeric leveraged-funds position` };
  const asOf = now.report_date_as_yyyy_mm_dd.slice(0, 10);
  return { asOf, text: `CFTC TFF JPY leveraged funds net ${fmt(a)} (wk to ${asOf.slice(5)}, Δ ${fmt(a - b, true)} w/w)`, sources: [{ date: asOf, url }] };
}

export async function measure(fetchImpl: FetchLike = fetch): Promise<Measured> {
  const res = await fetchImpl(QUERY_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return { error: `CFTC TFF ${CODE}: HTTP ${res.status}` };
  return measureCftcYen((await res.json()) as TffRow[], QUERY_URL);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = process.argv.includes("--json");
  let m: Measured;
  try {
    m = await measure();
  } catch (e) {
    m = { error: `CFTC TFF ${CODE}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  console.log(json ? JSON.stringify(m) : "error" in m ? `probe:cftc-yen — ${m.error}` : m.text);
}
