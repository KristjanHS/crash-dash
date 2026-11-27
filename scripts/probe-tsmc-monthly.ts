/** `npm run -s probe:tsmc-monthly [-- --json]` — the semis `tsmc_monthly` sign's `measure`: keyless TWSE OpenAPI `t187ap05_L` monthly revenue, TSMC (2330)
 *  latest month, m/m + y/y vs the +30 % line. asOf = the table date capped at the 10th of the next month (the filing deadline), so it ages out at the next print. */
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../src/fetch-budget.js";
import type { Measured } from "../src/ladder-run.js";

const CODE = "2330";
const YOY_LINE = 30;
export const QUERY_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L";
export type RevenueRow = Record<string, string>;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ROC `YYYMM` / `YYYMMDD` (民國 year + 1911) → `{y, m, d?}`; null when malformed. */
export function rocDate(s: string | undefined): { y: number; m: number; d?: number } | null {
  const x = /^(\d{2,3})(\d{2})(\d{2})?$/.exec(s ?? "");
  if (!x) return null;
  const [y, m, d] = [Number(x[1]) + 1911, Number(x[2]), x[3] === undefined ? undefined : Number(x[3])];
  return m >= 1 && m <= 12 && (d === undefined || (d >= 1 && d <= 31)) ? { y, m, ...(d !== undefined && { d }) } : null;
}
const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const pct = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)} %`;
const bn = (thousands: number): string => `NT$${(thousands / 1e6).toFixed(2)}B`;

/** The 2330 row → month, revenue (NT$B), m/m, y/y vs +30 %, prior month; `{error}` on a missing row or a non-numeric/malformed field. */
export function measureTsmcMonthly(rows: readonly RevenueRow[], url: string): Measured {
  const r = rows.find((x) => x["公司代號"] === CODE);
  if (!r) return { error: `TWSE t187ap05_L: no ${CODE} row in ${rows.length} row(s)` };
  const ym = rocDate(r["資料年月"]);
  if (!ym || ym.d !== undefined) return { error: `TWSE t187ap05_L ${CODE}: malformed 資料年月 ${JSON.stringify(r["資料年月"])}` };
  const [rev, prev, mom, yoy, cum] = ["營業收入-當月營收", "營業收入-上月營收", "營業收入-上月比較增減(%)", "營業收入-去年同月增減(%)", "累計營業收入-前期比較增減(%)"].map((k) => (r[k]?.trim() ? Number(r[k]) : NaN));
  if (![rev, prev, mom, yoy, cum].every((n) => Number.isFinite(n)) || !(rev! > 0 && prev! > 0)) return { error: `TWSE t187ap05_L ${CODE}: non-numeric revenue field` };
  const [ny, nm] = ym.m === 12 ? [ym.y + 1, 1] : [ym.y, ym.m + 1];
  const deadline = iso(ny, nm, 10);
  const t = rocDate(r["出表日期"]);
  const table = t?.d !== undefined ? iso(t.y, t.m, t.d) : deadline;
  const asOf = table < deadline ? table : deadline;
  const [py, pm] = ym.m === 1 ? [ym.y - 1, 12] : [ym.y, ym.m - 1];
  const month = `${MON[ym.m - 1]} ${ym.y}`;
  const text =
    `TWSE ${CODE} monthly ${asOf.slice(5)}: ${month} revenue ${bn(rev!)}, m/m ${pct(mom!)} (${mom! < 0 ? "fall" : mom! > 0 ? "rise" : "flat"}), ` +
    `y/y ${pct(yoy!)} (${yoy! < YOY_LINE ? "<" : "≥"} +${YOY_LINE} %) · prior month ${MON[pm - 1]} ${py} ${bn(prev!)} · Jan–${MON[ym.m - 1]} cum y/y ${pct(cum!)}`;
  return { asOf, text, sources: [{ date: asOf, url }] };
}

export async function measure(fetchImpl: FetchLike = fetch): Promise<Measured> {
  const res = await fetchImpl(QUERY_URL, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return { error: `TWSE t187ap05_L: HTTP ${res.status}` };
  const body: unknown = await res.json();
  return measureTsmcMonthly(Array.isArray(body) ? (body as RevenueRow[]) : [], QUERY_URL);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = process.argv.includes("--json");
  let m: Measured;
  try {
    m = await measure();
  } catch (e) {
    m = { error: `TWSE t187ap05_L: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  console.log(json ? JSON.stringify(m) : "error" in m ? `probe:tsmc-monthly — ${m.error}` : m.text);
}
