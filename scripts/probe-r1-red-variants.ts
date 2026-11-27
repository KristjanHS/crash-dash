// R1 RED-rule variants — which of the shipped RED paths (fixed inversion cut, armed-rung bull-steepener
// escalation) survive a regime-relative gate, vs a percentile red. Behind the 2026-08-31 fresh-inversion
// ruling. Run: `npx tsx scripts/probe-r1-red-variants.ts`.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { T10Y3M_DRAWDOWN } from "../src/registry-fred.js";
import { postInversionCutSeries, armedExpandingCutSeries, drawdownCutSeries, steepenerEscalationSeries } from "../src/scorers-core.js";
import { readEnv } from "../src/config.js";

const env = readEnv();
const R1 = ALL_INDICATORS.find((i) => i.id === "R1")!;
const cfg = R1.postInversionCooldown!, dd = T10Y3M_DRAWDOWN; // leg un-wired from R1 2026-08-31, kept as code
const [obs, short] = await Promise.all([realFeeds.fetchSeries("T10Y3M", { since: "2006-01-01", now: new Date(), env }), realFeeds.fetchSeries("DGS3MO", { since: "2006-01-01", now: new Date(), env })]);
const v = obs.map((o) => o.value), d = obs.map((o) => o.date), N = v.length;
const armedCut = postInversionCutSeries(v, cfg, d);
const floorFires = v.map((x, i) => armedCut[i] !== null && x < armedCut[i]!);
const bull = steepenerEscalationSeries(obs, short, cfg);
const ddCut = drawdownCutSeries(v, dd);
const ddBelow = v.map((x, i) => ddCut[i] !== null && x < ddCut[i]!);
const ddGate = steepenerEscalationSeries(obs, short, { shortLegWindow: dd.gateWindow, shortLegDropBp: dd.gateBp }, "either");
const ddFire = ddBelow.map((b, i) => b && ddGate[i]!);
const redPct = (p: number, clamp: [number, number]) => armedExpandingCutSeries(v, cfg, d, [{ pctile: p, clamp, warmupHold: null }])[0]!;
const inv = v.map((x) => x < 0);
type V = { name: string; red: boolean[] };
const esc = (gated: boolean) => floorFires.map((f, i) => f && bull[i]! && (!gated || ddBelow[i]!));
const variants: V[] = [
  { name: "S  shipped: red=inv | armed&bull", red: inv.map((r, i) => r || esc(false)[i]!) },
  { name: "G  gated esc: red=inv | armed&bull&ddBelow", red: inv.map((r, i) => r || esc(true)[i]!) },
  { name: "G+fresh: red=inv&ddBelow | esc(gated)", red: inv.map((r, i) => (r && ddBelow[i]!) || esc(true)[i]!) },
  { name: "G+freshOrGate: red=inv&(ddBelow|gate)|esc", red: inv.map((r, i) => (r && (ddBelow[i]! || ddGate[i]!)) || esc(true)[i]!) },
];
for (const p of [0.15, 0.2, 0.25, 0.3]) {
  const rc = redPct(p, [-0.8, 0.0]);
  // armed ⇒ red at the dynamic cut (≤0 by clamp); unarmed ⇒ fixed 0.0
  variants.push({ name: `G+pct${p}: red=(armed? v<pct : inv) | esc(gated)`, red: v.map((x, i) => (rc[i] !== null ? x < rc[i]! : x < 0) || esc(true)[i]!) });
}
const ONSETS = ["2007-12-03", "2020-02-20"];
const REC: Array<[string, string]> = [["2007-12-01", "2009-06-30"], ["2020-02-01", "2020-04-30"]];
const inRec = (dt: string) => REC.some(([a, b]) => dt >= a && dt <= b);
const oIdx = ONSETS.map((o) => d.findIndex((x) => x >= o));
const useful = (i: number) => inRec(d[i]!) || oIdx.some((oi) => i <= oi && oi - i <= 504);
const calmDays = d.filter((_, i) => !useful(i)).length;
const win = (a: string, b: string) => d.map((x, i) => (x >= a && x <= b ? i : -1)).filter((i) => i >= 0);
const W1 = win("2024-08-01", "2026-02-28"), W2 = win("2022-07-01", "2024-07-31"), W3 = win("2026-03-01", "2099-01-01");
const lead = (fire: boolean[], oi: number) => { for (let i = Math.max(0, oi - 504); i <= oi; i++) if (fire[i]) return `${oi - i}d`; return "none"; };
const cnt = (fire: boolean[], idx: number[]) => idx.filter((i) => fire[i]).length;
const recIdx = d.map((x, i) => (inRec(x) ? i : -1)).filter((i) => i >= 0);
console.log(`T10Y3M ${d[0]}..${d[N-1]} N=${N}; window A=2024-08..2026-02 (${W1.length}d), B=2022-07..2024-07 deep inversion (${W2.length}d), C=2026-03..today (${W3.length}d), rec days=${recIdx.length}`);
console.log(`ddBelow days total ${ddBelow.filter(Boolean).length}; in A ${cnt(ddBelow, W1)}; ddFire in A ${cnt(ddFire, W1)}`);
console.log("variant                                        | RED'07 RED'20 | RED total calm% | RED A   B    C  | RED in rec | today");
for (const x of variants) {
  const calm = cnt(x.red, d.map((_, i) => i).filter((i) => !useful(i))) / calmDays;
  console.log(`${x.name.padEnd(46)} | ${lead(x.red, oIdx[0]!).padStart(6)} ${lead(x.red, oIdx[1]!).padStart(6)} | ${String(x.red.filter(Boolean).length).padStart(5)} ${(100*calm).toFixed(1).padStart(8)}% | ${String(cnt(x.red, W1)).padStart(3)}/${W1.length} ${String(cnt(x.red, W2)).padStart(3)} ${String(cnt(x.red, W3)).padStart(3)} | ${String(cnt(x.red, recIdx)).padStart(3)}/${recIdx.length} | ${x.red[N-1] ? "RED" : "not"}`);
}
// monthly RED counts, window A, for S vs G vs G+fresh vs G+pct0.2
const show = [0, 1, 2, 5];
console.log("\nmonth   " + show.map((k) => variants[k]!.name.slice(0, 9).padStart(10)).join(""));
const months = [...new Set(W1.map((i) => d[i]!.slice(0, 7)))];
for (const m of months) { const idx = W1.filter((i) => d[i]!.startsWith(m)); console.log(`${m} ` + show.map((k) => `${String(cnt(variants[k]!.red, idx)).padStart(7)}/${String(idx.length).padEnd(2)}`).join("")); }
// where does the 2007/2020 first RED come from under G?
for (const [k, oi] of oIdx.entries()) { const g = variants[1]!.red; for (let i = oi - 504; i <= oi; i++) if (g[i]) { console.log(`G first RED before ${ONSETS[k]}: ${d[i]} v=${v[i]!.toFixed(2)} inv=${inv[i]} esc=${esc(true)[i]}`); break; } }
