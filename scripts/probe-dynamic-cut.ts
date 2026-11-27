// R1 dynamic-cut research sim: replays the three
// surviving candidate cut lines vs the static 0.85 floor over 2006→now T10Y3M, on the SHIPPED arming
// arcs. Run: `npx tsx scripts/probe-dynamic-cut.ts`. Data older than 2006-01-01 is excluded by ruling.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { postInversionCutSeries } from "../src/scorers-core.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const SINCE = "2006-01-01";
const cfg = ALL_INDICATORS.find((i) => i.id === "R1")!.postInversionCooldown!;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const [spread, dgs3mo, tp10] = await Promise.all([
  realFeeds.fetchSeries("T10Y3M", { since: SINCE, now: new Date(), env }),
  realFeeds.fetchSeries("DGS3MO", { since: SINCE, now: new Date(), env }),
  realFeeds.fetchSeries("THREEFYTP10", { since: SINCE, now: new Date(), env }),
]);
const values = spread.map((o) => o.value);
const dates = spread.map((o) => o.date);
console.log(`T10Y3M ${dates[0]}→${dates.at(-1)} (${values.length} obs); cfg ${JSON.stringify(cfg)}`);

// Carry-forward join of a secondary series onto the spread's date grid.
function joined(series: { date: string; value: number }[]): number[] {
  const map = new Map(series.map((o) => [o.date, o.value]));
  let last = series[0]!.value;
  return dates.map((d) => (last = map.get(d) ?? last));
}

// Static baseline — also defines the arcs every candidate shares (release stays LEVEL-only, ruled).
const cuts = postInversionCutSeries(values, cfg, dates);

// (a) expanding p40 from 2006, 1260-obs warm-up holding floorLevel, clamp [0.50, 1.20].
const seen: number[] = [];
const cutA = values.map((v, i) => {
  seen.push(v);
  if (i + 1 < 1260) return cfg.floorLevel;
  const sorted = [...seen].sort((x, y) => x - y);
  return clamp(sorted[Math.floor(0.4 * (sorted.length - 1))]!, 0.5, 1.2);
});

// (b) slope trigger: 5-obs-mean spread rising ≥ +0.50pp over 63 obs AND 3m yield falling (bull gate).
const dg = joined(dgs3mo);
const sm = values.map((_, i) => {
  const w = values.slice(Math.max(0, i - 4), i + 1);
  return w.reduce((a, b) => a + b, 0) / w.length;
});
const flagB = values.map((_, i) => i >= 67 && sm[i]! - sm[i - 63]! >= 0.5 && dg[i]! - dg[i - 63]! < 0);

// (d) TP-conditioned: clamp(0.85 + (TP21 − 1.65), 0.35, 1.35), TP21 = 21-obs mean of ACM 10y TP.
const tp = joined(tp10);
const cutD = tp.map((_, i) => {
  const w = tp.slice(Math.max(0, i - 20), i + 1);
  return clamp(cfg.floorLevel + w.reduce((a, b) => a + b, 0) / w.length - 1.65, 0.35, 1.35);
});

type Cand = { id: string; amber: (i: number) => boolean; line?: number[] };
const cands: Cand[] = [
  { id: "a-pctile", amber: (i) => values[i]! < cutA[i]!, line: cutA },
  { id: "b-slope", amber: (i) => flagB[i]! },
  { id: "d-tp", amber: (i) => values[i]! < cutD[i]!, line: cutD },
];
const staticAmber = (i: number) => values[i]! < cfg.floorLevel;

// Arcs off the shared cut series; episode label by arc start date.
const arcs: Array<{ from: number; to: number }> = [];
for (let i = 0; i < cuts.length; i++) {
  if (cuts[i] === null) continue;
  if (i === 0 || cuts[i - 1] === null) arcs.push({ from: i, to: i });
  else arcs.at(-1)!.to = i;
}
const label = (d: string) =>
  d < "2009-01-01" ? "EP2006" : d >= "2019-01-01" && d < "2021-01-01" ? "EP2019" : d >= "2022-01-01" && d < "2025-01-01" ? "EP2022" : "FP-arc";
const ONSET: Record<string, string | undefined> = { EP2006: "2007-12-03", EP2019: "2020-02-20" };

for (const arc of arcs) {
  const name = label(dates[arc.from]!);
  console.log(`\n=== ${name} armed ${dates[arc.from]}→${dates[arc.to]} (${arc.to - arc.from + 1} obs) ===`);
  const onset = ONSET[name];
  const onsetIdx = onset === undefined ? undefined : dates.findIndex((d) => d >= onset);
  if (onsetIdx !== undefined && onsetIdx > arc.to)
    console.log(`  static: RELEASED ${onsetIdx - arc.to} obs before onset ${onset} (arc ends ${dates[arc.to]}) — all candidates share the release`);
  for (const c of cands) {
    let extra = 0, lost = 0, firstDiv = "", lastDiv = "";
    for (let i = arc.from; i <= arc.to; i++) {
      const s = staticAmber(i), k = c.amber(i);
      if (s === k) continue;
      if (k) extra++; else lost++;
      firstDiv ||= dates[i]!;
      lastDiv = dates[i]!;
    }
    let onsetNote = "";
    if (onsetIdx !== undefined && onsetIdx <= arc.to) {
      const at = (fn: (i: number) => boolean) => {
        if (fn(onsetIdx)) {
          let j = onsetIdx;
          while (j > arc.from && fn(j - 1)) j--;
          return `AMBER at onset (run since ${dates[j]}, ${onsetIdx - j} obs)`;
        }
        let j = onsetIdx;
        while (j >= arc.from && !fn(j)) j--;
        return j < arc.from ? "never AMBER pre-onset" : `GREEN at onset (last AMBER ${dates[j]}, ${onsetIdx - j} obs before)`;
      };
      onsetNote = ` | static: ${at(staticAmber)} | cand: ${at(c.amber)}`;
    }
    console.log(`  ${c.id}: extra-AMBER ${extra} obs, lost-AMBER ${lost} obs${firstDiv ? ` (diverges ${firstDiv}→${lastDiv})` : ""}${onsetNote}`);
  }
  // Monthly tail rows (last obs per month) — the ASCII-preview feedstock for the ruling round.
  const rows: string[] = [];
  for (let i = arc.from; i <= arc.to; i++)
    if (i === arc.to || dates[i]!.slice(0, 7) !== dates[i + 1]!.slice(0, 7))
      rows.push(
        `  ${dates[i]} close ${values[i]!.toFixed(2).padStart(5)} | a ${cutA[i]!.toFixed(2)} | d ${cutD[i]!.toFixed(2)} | b${flagB[i] ? "*" : " "} | ${staticAmber(i) ? "S" : "."}${cands.map((c) => (c.amber(i) ? c.id[0]!.toUpperCase() : ".")).join("")}`,
      );
  const shown = name === "FP-arc" ? rows : rows.slice(-30);
  if (shown.length < rows.length) console.log(`  … (${rows.length - shown.length} earlier monthly rows omitted)`);
  console.log(shown.join("\n"));
}
