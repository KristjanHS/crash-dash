// R1 literature-faithful variants (Estrella–Trubin 2006 monthly-mean ≥3-negative-months, Harvey 2024 quarterly
// mean) vs the shipped daily-close legs — the sim behind the 2026-08-31 realignment fork.
// Run: `npm run probe:r1-lit`.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { T10Y3M_DRAWDOWN } from "../src/registry-fred.js";
import { postInversionCutSeries, drawdownCutSeries, steepenerEscalationSeries, smoothedLevelReadingSeries } from "../src/scorers-core.js";
import { SMOOTHED_LEVEL_OF } from "../src/family-descriptor-rows.js";
import { readEnv } from "../src/config.js";

const env = readEnv();
const R1 = ALL_INDICATORS.find((i) => i.id === "R1")!; const cfg = R1.postInversionCooldown!, dd = T10Y3M_DRAWDOWN; // leg un-wired 2026-08-31
const [obs, short] = await Promise.all([realFeeds.fetchSeries("T10Y3M", { since: "2004-01-01", now: new Date(), env }), realFeeds.fetchSeries("DGS3MO", { since: "2004-01-01", now: new Date(), env })]);
const v = obs.map((o) => o.value), d = obs.map((o) => o.date), N = v.length;
const mean = (w: number) => v.map((_, i) => (i + 1 < w ? NaN : v.slice(i - w + 1, i + 1).reduce((a, b) => a + b, 0) / w));
const m21 = mean(21), m63 = mean(63);
// shipped
const armedCut = postInversionCutSeries(v, cfg, d); const floorFires = v.map((x, i) => armedCut[i] !== null && x < armedCut[i]!);
const bull = steepenerEscalationSeries(obs, short, cfg); const ddCut = drawdownCutSeries(v, dd);
const ddBelow = v.map((x, i) => ddCut[i] !== null && x < ddCut[i]!);
const ddGate = steepenerEscalationSeries(obs, short, { shortLegWindow: dd.gateWindow, shortLegDropBp: dd.gateBp }, "either");
const ship = v.map((x, i) => (x < 0 || (floorFires[i] && bull[i]!) ? "R" : floorFires[i] || (ddBelow[i] && ddGate[i]) ? "A" : "G"));
const ruled = v.map((x, i) => ((x < 0 && ddBelow[i]) || (floorFires[i] && bull[i]! && ddBelow[i]) ? "R" : x < 0 || floorFires[i] || (ddBelow[i] && ddGate[i]) ? "A" : "G"));
// literature variants: floor in mean space via the shipped rung cfg (arm 30 consecutive <0 of the MEAN, release 10 ≥ 0.85)
const floorOn = (s: number[]) => { const c = postInversionCutSeries(s.map((x) => (isNaN(x) ? 9 : x)), cfg, d); return s.map((x, i) => c[i] !== null && x < c[i]!); };
const f21 = floorOn(m21);
// L1: E&T — AMBER = monthly mean < 0 (or armed floor); RED = ≥3 negative month-averages in trailing 12 months (≈ ≥63 obs with m21<0 in the last 252)
const negCount = m21.map((_, i) => { let c = 0; for (let j = Math.max(0, i - 251); j <= i; j++) if (m21[j]! < 0) c++; return c; });
const L1 = m21.map((x, i) => (negCount[i]! >= 63 ? "R" : x < 0 || f21[i] ? "A" : "G"));
// L2: Harvey — RED = quarterly mean < 0; AMBER = monthly mean < 0 or armed floor
const L2 = m21.map((x, i) => (m63[i]! < 0 ? "R" : x < 0 || f21[i] ? "A" : "G"));
// L3: L2 without any post-inversion floor (pure level: RED q-mean<0, AMBER m-mean<0, else GREEN)
const L3 = m21.map((x, i) => (m63[i]! < 0 ? "R" : x < 0 ? "A" : "G"));
// Stage 3 step 0 (plan): the repo's calm-regime early-warning leg riding ON TOP of L2 (GREEN→AMBER only, as
// `withPostInversionFloor` applies it) — raw-close drawdown (the shipped leg, gated), and the same leg run over the
// 21-obs mean (gated / ungated), which is the only form a `SMOOTHED_LEVEL_OF` carrier could host.
const ddFire = ddBelow.map((b, i) => b && ddGate[i]!);
const L2dd = L2.map((s, i) => (s === "G" && ddFire[i] ? "A" : s));
const ddCutM = drawdownCutSeries(m21, dd); const ddBelowM = m21.map((x, i) => ddCutM[i] !== null && x < ddCutM[i]!);
const L2ddM = L2.map((s, i) => (s === "G" && ddBelowM[i] && ddGate[i] ? "A" : s));
const L2ddMu = L2.map((s, i) => (s === "G" && ddBelowM[i] ? "A" : s));
const ONSETS = ["2007-12-03", "2020-02-20"]; const REC: Array<[string, string]> = [["2007-12-01", "2009-06-30"], ["2020-02-01", "2020-04-30"]];
const inRec = (dt: string) => REC.some(([a, b]) => dt >= a && dt <= b); const oIdx = ONSETS.map((o) => d.findIndex((x) => x >= o));
const useful = (i: number) => inRec(d[i]!) || oIdx.some((oi) => i <= oi && oi - i <= 504);
const since06 = d.map((x, i) => (x >= "2006-01-01" ? i : -1)).filter((i) => i >= 0); const calmIdx = since06.filter((i) => !useful(i));
const win = (a: string, b: string) => d.map((x, i) => (x >= a && x <= b ? i : -1)).filter((i) => i >= 0);
const A = win("2024-08-01", "2026-02-28"), B = win("2022-07-01", "2024-07-31"), C = win("2026-03-01", "2099-01-01"), Y25 = win("2025-01-01", "2025-12-31");
const lead = (s: string[], oi: number, st: string) => { for (let i = oi - 504; i <= oi; i++) if (s[i] === st) return `${oi - i}d`; return "none"; };
const cnt = (s: string[], idx: number[], st: string) => idx.filter((i) => s[i] === st).length;
const V: Array<[string, string[]]> = [["shipped", ship], ["ruled(gate+fresh)", ruled], ["L1 E&T 3neg-months", L1], ["L2 Harvey q-mean", L2], ["L3 Harvey, no floor", L3], ["L2+dd raw (gated)", L2dd], ["L2+dd m21 (gated)", L2ddM], ["L2+dd m21 ungated", L2ddMu]];
console.log(`variant             | RED'07 AMB'07 | RED'20 AMB'20 | calm R%  A% | A: R/A/G (392) | B: R/A/G | 2025 R/A/G | C 2026-03→ R/A/G (${C.length}) | today`);
for (const [n, s] of V) console.log(`${n.padEnd(19)} | ${lead(s, oIdx[0]!, "R").padStart(6)} ${lead(s, oIdx[0]!, "A").padStart(6)} | ${lead(s, oIdx[1]!, "R").padStart(6)} ${lead(s, oIdx[1]!, "A").padStart(6)} | ${(100 * cnt(s, calmIdx, "R") / calmIdx.length).toFixed(1).padStart(5)} ${(100 * cnt(s, calmIdx, "A") / calmIdx.length).toFixed(1).padStart(5)} | ${String(cnt(s, A, "R")).padStart(3)}/${String(cnt(s, A, "A")).padStart(3)}/${String(cnt(s, A, "G")).padStart(3)} | ${String(cnt(s, B, "R")).padStart(3)}/${String(cnt(s, B, "A")).padStart(3)}/${String(cnt(s, B, "G")).padStart(3)} | ${String(cnt(s, Y25, "R")).padStart(3)}/${String(cnt(s, Y25, "A")).padStart(3)}/${String(cnt(s, Y25, "G")).padStart(3)} | ${String(cnt(s, C, "R")).padStart(3)}/${String(cnt(s, C, "A")).padStart(3)}/${String(cnt(s, C, "G")).padStart(3)} | ${s[N - 1]}`);
const months = [...new Set(A.map((i) => d[i]!.slice(0, 7)))];
console.log("\nmajority state per month, window A\n" + "".padEnd(19) + " " + months.map((m) => m.slice(5)).join(" "));
for (const [n, s] of V) console.log(n.padEnd(19) + " " + months.map((m) => { const idx = A.filter((i) => d[i]!.startsWith(m)); const r = cnt(s, idx, "R"), a = cnt(s, idx, "A"); return (r > idx.length / 2 ? "R" : a + r > idx.length / 2 ? (r > 0 ? "r" : "A") : "G").padStart(2); }).join(" "));
const maj = (s: string[], idx: number[]) => { const r = cnt(s, idx, "R"), a = cnt(s, idx, "A"); return (r > idx.length / 2 ? "R" : a + r > idx.length / 2 ? (r > 0 ? "r" : "A") : "G").padStart(2); };
const monthsC = [...new Set(C.map((i) => d[i]!.slice(0, 7)))];
console.log("\nmajority state per month, window C = 2026-03 → today (the goal window)\n" + "".padEnd(19) + " " + monthsC.map((m) => m.slice(5)).join(" "));
for (const [n, s] of V) console.log(n.padEnd(19) + " " + monthsC.map((m) => maj(s, C.filter((i) => d[i]!.startsWith(m)))).join(" "));
console.log(`\n2026 m21 today ${m21[N-1]!.toFixed(2)} m63 ${m63[N-1]!.toFixed(2)} negCount ${negCount[N-1]} floor21 ${f21[N-1]}`);
// Agreement check (Stage 3.1, 2026-08-31): the SHIPPED scorer (`SMOOTHED_LEVEL_OF.R1` windows) must reproduce L2's
// per-day raw states over the same history — a non-zero mismatch count is the falsifier.
const sw = SMOOTHED_LEVEL_OF.R1!; const prod = smoothedLevelReadingSeries(R1, obs, sw.window, undefined, sw.redWindow);
const prodByDate = new Map(prod.map((r) => [r.date, r.rawState[0]!]));
let mismatch = 0, compared = 0; for (let i = 0; i < N; i++) { const p = prodByDate.get(d[i]!); if (p === undefined || isNaN(m63[i]!)) continue; compared++; if (p !== L2[i]) mismatch++; }
console.log(`scorer vs L2 rule: ${compared} days compared, ${mismatch} mismatches (windows ${sw.window}/${sw.redWindow})`);
process.exitCode = mismatch ? 1 : 0; // falsifier: the shipped scorer must reproduce L2's per-day states
