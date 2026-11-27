// NTFS feed spike (plan D): fetches the Fed's Svensson/GSW
// fitted zero-curve dataset (feds200628, FEDS 2018-055), computes the near-term forward spread
// (expected 3m rate 18mo ahead − current 3m, both off the NSS parameters, continuously compounded),
// and replays 1990→now against R1's feed T10Y3M. Run: `npm run probe:ntfs`.
// Stable keyless CSV: https://www.federalreserve.gov/data/yield-curve-tables/feds200628.csv
import { realFeeds } from "../src/feed-ports.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const GSW_CSV_URL = "https://www.federalreserve.gov/data/yield-curve-tables/feds200628.csv";
const FROM = "1990-01-01";

// --- fetch + parse the GSW CSV (metadata preamble rows precede the real `Date,...` header) ---
const res = await fetch(GSW_CSV_URL, {
  headers: { "User-Agent": "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)" },
});
if (!res.ok) throw new Error(`GSW CSV fetch failed: ${res.status} ${res.statusText}`);
const lines = (await res.text()).trim().split("\n");
const headerIdx = lines.findIndex((l) => l.startsWith("Date,"));
if (headerIdx < 0) throw new Error("GSW CSV: no `Date,...` header row found (format drift)");
const header = lines[headerIdx]!.split(",");
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`GSW CSV: missing column ${name}`);
  return i;
};
const [iB0, iB1, iB2, iB3, iT1, iT2] = [
  col("BETA0"), col("BETA1"), col("BETA2"), col("BETA3"), col("TAU1"), col("TAU2"),
];

// NSS zero-coupon yield at maturity n years; β3/τ2 may be NA pre-Svensson → term drops to 0.
const nssYield = (n: number, b0: number, b1: number, b2: number, b3: number, t1: number, t2: number): number => {
  const x1 = n / t1;
  const load1 = (1 - Math.exp(-x1)) / x1;
  let y = b0 + b1 * load1 + b2 * (load1 - Math.exp(-x1));
  if (Number.isFinite(b3) && Number.isFinite(t2) && t2 > 0) {
    const x2 = n / t2;
    y += b3 * ((1 - Math.exp(-x2)) / x2 - Math.exp(-x2));
  }
  return y;
};

const ntfs: Array<{ date: string; value: number }> = [];
for (let i = headerIdx + 1; i < lines.length; i++) {
  const f = lines[i]!.split(",");
  const date = f[0] ?? "";
  if (date < FROM) continue;
  const [b0, b1, b2, t1] = [Number(f[iB0]), Number(f[iB1]), Number(f[iB2]), Number(f[iT1])];
  if (![b0, b1, b2, t1].every(Number.isFinite) || t1 <= 0) continue;
  const b3 = Number(f[iB3]);
  const t2 = Number(f[iT2]);
  // 3m forward rate 6 quarters ahead (implied between 1.5y and 1.75y) minus the current 3m rate.
  const y150 = nssYield(1.5, b0, b1, b2, b3, t1, t2);
  const y175 = nssYield(1.75, b0, b1, b2, b3, t1, t2);
  const fwd3m = (y175 * 1.75 - y150 * 1.5) / 0.25;
  const spot3m = nssYield(0.25, b0, b1, b2, b3, t1, t2);
  ntfs.push({ date, value: fwd3m - spot3m });
}

const t10y3m = (await realFeeds.fetchSeries("T10Y3M", { fullHistory: true, now: new Date(), env })).filter((o) => o.date >= FROM);

// --- inversion episodes (value < 0, consecutive obs) ---
type Episode = { from: string; to: string; obs: number };
const episodes = (series: Array<{ date: string; value: number }>): Episode[] => {
  const eps: Episode[] = [];
  let prev = false;
  for (const o of series) {
    const inv = o.value < 0;
    if (inv && !prev) eps.push({ from: o.date, to: o.date, obs: 0 });
    if (inv) {
      const e = eps.at(-1)!;
      e.to = o.date;
      e.obs++;
    }
    prev = inv;
  }
  return eps;
};
const fmt = (eps: Episode[]) => eps.map((e) => `  ${e.from} → ${e.to} (${e.obs} obs)`).join("\n");
const ntfsEps = episodes(ntfs);
const t10Eps = episodes(t10y3m);
console.log(`NTFS inversion episodes (${ntfsEps.length}):\n${fmt(ntfsEps)}`);
console.log(`T10Y3M inversion episodes (${t10Eps.length}):\n${fmt(t10Eps)}`);

// --- lead/lag per recession-adjacent episode: first inversion inside each window ---
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const windows: Array<[string, string, string]> = [
  ["2001", "1999-06-01", "2001-03-31"],
  ["2008", "2005-06-01", "2008-01-31"],
  ["2020", "2018-06-01", "2020-02-29"],
  ["2022+", "2022-01-01", "2023-12-31"],
];
for (const [label, from, to] of windows) {
  const first = (eps: Episode[]) => eps.find((e) => e.from >= from && e.from <= to)?.from;
  const n = first(ntfsEps);
  const t = first(t10Eps);
  const lead = n && t ? `NTFS ${days(n, t) >= 0 ? "leads" : "lags"} by ${Math.abs(days(n, t))} days` : "n/a";
  console.log(`${label}: NTFS first-inversion ${n ?? "none"} vs T10Y3M ${t ?? "none"} — ${lead}`);
}

const last = ntfs.at(-1)!;
const lagDays = days(last.date, isoDay(new Date()));
console.log(`latest NTFS ${last.date} = ${last.value.toFixed(3)} (T10Y3M latest ${t10y3m.at(-1)!.date} = ${t10y3m.at(-1)!.value})`);
console.log(`dataset refresh lag: ${lagDays} calendar days behind today`);
