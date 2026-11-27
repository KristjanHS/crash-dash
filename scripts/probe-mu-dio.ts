/** `npm run -s probe:mu-dio [-- --json]` — the semis `mu_dio` sign's `measure`: keyless SEC EDGAR XBRL, Micron latest fiscal quarter DIO (avg inventory, Micron's basis) vs ~140 d.
 *  FQ4 = 10-K FY COGS minus the three 10-Q quarters; asOf = the filing's `filed` date. Guidance ("guided to rise/fall") is textual — not covered. */
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../src/fetch-budget.js";
import type { Measured } from "../src/ladder-run.js";

const BASE = "https://data.sec.gov/api/xbrl/companyconcept/CIK0000723125/us-gaap";
export const INV_URL = `${BASE}/InventoryNet.json`;
export const COGS_URL = `${BASE}/CostOfGoodsAndServicesSold.json`;
const LINE = 140;
export type Fact = { start?: string; end: string; val: number; fy: number; fp: string; form: string; filed: string; accn?: string; frame?: string };
export type Quarter = { start: string; end: string; cogs: number; days: number; fy: number; q: number; form: string; filed: string };

const day = (d: string, n: number): string => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const span = (s: string, e: string): number => Math.round((Date.parse(e) - Date.parse(s)) / 864e5) + 1;
const ok = (f: Fact): boolean => Number.isFinite(f.val) && f.val > 0 && typeof f.filed === "string";
/** Per period key, the ORIGINAL filing's fact (earliest `filed`) — later filings re-report it as a comparative. */
const originals = (facts: readonly Fact[], key: (f: Fact) => string): Map<string, Fact> => {
  const m = new Map<string, Fact>();
  for (const f of facts) {
    const held = m.get(key(f));
    if (ok(f) && (!held || f.filed < held.filed)) m.set(key(f), f);
  }
  return m;
};

/** COGS facts → discrete fiscal quarters (80–105-day spans), plus each FY's FQ4 = FY − its three contiguous FQ1–FQ3; sorted by end. */
export function quarters(cogs: readonly Fact[]): Quarter[] {
  const facts = [...originals(cogs.filter((f) => f.start), (f) => `${f.start}/${f.end}`).values()];
  const out: Quarter[] = facts.flatMap((f) => ((d) => (d >= 80 && d <= 105 ? [{ start: f.start!, end: f.end, cogs: f.val, days: d, fy: f.fy, q: f.fp === "FY" ? 4 : Number(f.fp.slice(1)), form: f.form, filed: f.filed }] : []))(span(f.start!, f.end)));
  for (const fy of facts.filter((f) => span(f.start!, f.end) >= 350)) {
    const inside = out.filter((q) => q.start >= fy.start! && q.end <= fy.end).sort((a, b) => a.end.localeCompare(b.end));
    if (inside.length !== 3 || inside.some((q, i) => q.start !== (i ? day(inside[i - 1]!.end, 1) : fy.start))) continue;
    const start = day(inside[2]!.end, 1);
    const cogsQ4 = fy.val - inside.reduce((a, q) => a + q.cogs, 0);
    if (cogsQ4 > 0) out.push({ start, end: fy.end, cogs: cogsQ4, days: span(start, fy.end), fy: fy.fy, q: 4, form: fy.form, filed: fy.filed });
  }
  return out.filter((q) => q.q >= 1 && q.q <= 4).sort((a, b) => a.end.localeCompare(b.end));
}

const fq = (q: Quarter): string => `FQ${q.q}-${String(q.fy).slice(2)}`;
const d1 = (n: number): string => `${n.toFixed(1)} d`;
const sd = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)} d`;

/** Latest + prior quarter DIO = avg(begin, end inventory) / COGS × days; `{error}` on no quarter pair or a missing/non-positive inventory. */
export function measureMuDio(inventory: readonly Fact[], cogs: readonly Fact[]): Measured {
  const qs = quarters(cogs);
  const [prior, latest] = qs.slice(-2);
  if (!latest || !prior) return { error: `EDGAR MU: ${qs.length} fiscal quarter(s) of COGS, need 2` };
  if (prior.end !== day(latest.start, -1)) return { error: `EDGAR MU: ${fq(latest)} has no adjoining prior quarter (prior ends ${prior.end})` };
  const inv = originals(inventory, (f) => f.end);
  const at = (d: string): number | undefined => inv.get(d)?.val;
  const [i0, i1, i2] = [at(day(prior.start, -1)), at(prior.end), at(latest.end)];
  if (i0 === undefined || i1 === undefined || i2 === undefined) return { error: `EDGAR MU: no InventoryNet at ${[day(prior.start, -1), prior.end, latest.end].filter((d) => at(d) === undefined).join(", ")}` };
  const dio = (a: number, b: number, q: Quarter): number => ((a + b) / 2 / q.cogs) * q.days;
  const [now, was, endBasis] = [dio(i1, i2, latest), dio(i0, i1, prior), (i2 / latest.cogs) * latest.days];
  const chg = now - was;
  const text =
    `EDGAR MU ${latest.form} filed ${latest.filed}: ${fq(latest)} (qtr to ${latest.end}, ${latest.days} d) DIO ${d1(now)} on avg inventory (Micron's basis), ${now > LINE ? ">" : "≤"} ~${LINE}d line; ` +
    `period-end basis ${d1(endBasis)} ($${(i2 / 1e9).toFixed(2)}B inventory / $${(latest.cogs / 1e9).toFixed(2)}B COGS) · prior ${fq(prior)} (to ${prior.end}) ${d1(was)} · ` +
    `change ${sd(chg)} q/q (${chg > 0 ? "rise" : chg < 0 ? "fall" : "flat"}) · "guided to rise/fall" NOT covered — guidance is textual (call/press release), not XBRL`;
  return { asOf: latest.filed, text, sources: [{ date: latest.filed, url: COGS_URL }, { date: latest.filed, url: INV_URL }] };
}

const usd = (body: unknown): Fact[] => ((u) => (Array.isArray(u) ? (u as Fact[]) : []))((body as { units?: { USD?: unknown } } | null)?.units?.USD);
export async function measure(fetchImpl: FetchLike = fetch): Promise<Measured> {
  const get = (url: string) => fetchImpl(url, { headers: { "User-Agent": "crash-dash-probe/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const [ri, rc] = await Promise.all([get(INV_URL), get(COGS_URL)]);
  if (!ri.ok || !rc.ok) return { error: `EDGAR MU: HTTP ${ri.status} InventoryNet / ${rc.status} CostOfGoodsAndServicesSold` };
  return measureMuDio(usd(await ri.json()), usd(await rc.json()));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = process.argv.includes("--json");
  let m: Measured;
  try {
    m = await measure();
  } catch (e) {
    m = { error: `EDGAR MU: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  console.log(json ? JSON.stringify(m) : "error" in m ? `probe:mu-dio — ${m.error}` : m.text);
}
