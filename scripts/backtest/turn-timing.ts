/**
 * Turn-timing event study — OFFLINE, READ-ONLY: per price drawdown episode, on which close each signal
 * rule first clears, measured against the episode's trough. Answers "how late / how early is this
 * re-entry form", never "is it profitable" (that is `event-study.ts`'s placebo harness).
 * Run: `npm run probe:turn-timing [-- --price=<fixture.csv>] [--signal=<fixture.csv>] [--mode=first]`.
 * Defaults: SMH adj closes × HY OAS (BAMLH0A0HYM2 vintage 1996→2025-04, then `hyoas.csv`).
 * `--signal=<dir>/vix.csv` runs the vol tables instead (`VOL_BOX` holds, `VOL_GATES`), reading `vix3m.csv` + `vxn.csv` beside it.
 * Cell = `<close lag vs trough>d <price at signal vs trough> dd<worst close after the signal, to episode end>`.
 * Default mode `after-stress` counts a clear only after one non-clear (or n/a) close — it times the RE-clear;
 * `--mode=first` is the shipped gate's read (a rule already clear at entry fills there).
 * Episode entry (−ENTER off the high) is later than the shipped `episodes` exit (DROP_K·σ), so a HY shock
 * closing between the two reads quiet here but is graded against its line in the replay.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { retraceLine, retraced } from "../../src/ladder-jobs.js";
import { SEMIS_RULES } from "../probe-semis-tranches.js";
import type { Pt } from "../ladder-replay.js";
import { shockOf, type ShockKnobs } from "../ladder-shock.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Episode = a close ≤ −ENTER off its trailing HIGH_N-close high, kept when its trough reaches −DEPTH; ends on a new HIGH_N-close high. */
export const TURN = { ENTER: 0.2, DEPTH: 0.25, HIGH_N: 250, WARMUP: 250 } as const;
/** The shipped shock anchor (shared by Semis/Value/Spit), so retrace rules measure the live form. */
const SHOCK: ShockKnobs = { BASE_N: SEMIS_RULES.BASE_N, SIGMA_N: SEMIS_RULES.SIGMA_N, BROKE_SD: SEMIS_RULES.BROKE_SD };

export type Series = { date: string; value: number }[];
export type Episode = { start: number; trough: number; end: number; open: boolean };
/** A rule reads the signal closes up to `i`; `start` = the episode's −ENTER entry index; `pts` = the signal as `Pt`s. */
export type Ctx = { v: number[]; i: number; start: number; dates: string[]; pts: Pt[]; shock: (i: number) => ReturnType<typeof shockOf> };
export type Rule = { id: string; role: string; clear: (c: Ctx) => boolean | null };

export function readCsv(rel: string): Series {
  return readFileSync(`${ROOT}${rel}`, "utf8").trim().split("\n").slice(1)
    .map((l) => l.split(","))
    .filter(([d, x]) => d && x !== undefined && x !== "." && Number.isFinite(Number(x)))
    .map(([d, x]) => ({ date: d!, value: Number(x) }));
}
/** `a` up to its last date, then `b` after it. */
export const stitch = (a: Series, b: Series): Series => [...a, ...b.filter((p) => p.date > (a.at(-1)?.date ?? ""))];
/** Both series on their shared dates. */
export function align(price: Series, signal: Series): { dates: string[]; px: number[]; sg: number[] } {
  const m = new Map(signal.map((p) => [p.date, p.value]));
  const both = price.filter((p) => m.has(p.date));
  return { dates: both.map((p) => p.date), px: both.map((p) => p.value), sg: both.map((p) => m.get(p.date)!) };
}

export function episodesOf(px: number[]): Episode[] {
  const out: Episode[] = [];
  let [ep, epHi] = [null as Episode | null, 0];
  px.forEach((p, i) => {
    const hi = Math.max(...px.slice(Math.max(0, i - TURN.HIGH_N + 1), i + 1));
    if (p >= hi) {
      if (ep && px[ep.trough]! / epHi - 1 <= -TURN.DEPTH) out.push({ ...ep, end: i, open: false });
      ep = null;
      return;
    }
    if (!ep && p / hi - 1 <= -TURN.ENTER) [ep, epHi] = [{ start: i, trough: i, end: i, open: true }, hi];
    if (ep && p < px[ep.trough]!) ep.trough = i;
  });
  if (ep && px[ep.trough]! / epHi - 1 <= -TURN.DEPTH) out.push({ ...ep, end: px.length - 1 });
  return out;
}

const ma = (v: number[], i: number, n: number): number | null => (i >= n - 1 ? v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : null);
const lt = (a: number, b: number | null): boolean | null => (b === null ? null : a < b);
/** Shipped retrace semantics (`hyRetrace`, probe-semis-tranches.ts): no shock → n/a (holds); closed before the episode start → quiet, clear. */
const retr = (frac: number, ageN = 0) => (c: Ctx): boolean | null => {
  const sh = c.shock(c.i);
  if (sh === null) return null;
  if (sh.closedAt !== null && sh.closedAt < c.dates[c.start]!) return true; // = `shockSince(…) === null`
  const aged = ageN === 0 || c.dates.indexOf(sh.peakDate) <= c.i - ageN;
  return aged && retraced(c.pts, c.i, retraceLine(sh, frac), { eps: 1e-9 });
};
/** The reviewed forms; add a form here, never a fork. */
export const RULES: readonly Rule[] = [
  { id: "retr⅓", role: "T1 gate (shipped)", clear: retr(1 / 3) },
  { id: "retr⅓+age10", role: "T1 gate (proposed)", clear: retr(1 / 3, 10) },
  { id: "retr½", role: "T2·T3 gate (proposed)", clear: retr(1 / 2) },
  { id: "retr½+age10", role: "T2·T3 gate (proposed alt)", clear: retr(1 / 2, 10) },
  { id: "retr⅔", role: "T3 credit (proposed)", clear: retr(2 / 3) },
  { id: "<MA50·Δ20<0", role: "T2 vote (shipped)", clear: (c) => ((m) => (m === null || c.i < 20 ? null : c.v[c.i]! < m && c.v[c.i]! - c.v[c.i - 20]! < 0))(ma(c.v, c.i, 50)) },
  { id: "≤1.1×low20", role: "T2·T3 gate (shipped)", clear: (c) => (c.i < 19 ? null : c.v[c.i]! <= 1.1 * Math.min(...c.v.slice(c.i - 19, c.i + 1))) },
  { id: "<1.1×MA200", role: "box credit HY half off (shipped)", clear: (c) => ((m) => lt(c.v[c.i]!, m === null ? null : 1.1 * m))(ma(c.v, c.i, 200)) },
  { id: "rel30<1.12", role: "box credit off (candidate)", clear: (c) => (c.i < 30 ? null : c.v[c.i]! / c.v[c.i - 30]! < 1.12) },
  { id: "rel30+noHi10", role: "box credit off (candidate)", clear: (c) => (c.i < 60 ? null : c.v[c.i]! / c.v[c.i - 30]! < 1.12 && Math.max(...c.v.slice(c.i - 9, c.i + 1)) < Math.max(...c.v.slice(c.i - 59, c.i + 1))) },
  { id: "Δ30<0.22", role: "F1 amber velocity off (regime-bound ref)", clear: (c) => (c.i < 30 ? null : c.v[c.i]! - c.v[c.i - 30]! < 0.22) },
  { id: "<MA200", role: "late confirm (ref)", clear: (c) => lt(c.v[c.i]!, ma(c.v, c.i, 200)) },
];

export type Cell = { at: number; lag: number; vsTrough: number; further: number } | null;
/** First clear close on/after the start; `after-stress` first needs one non-clear or n/a close (the signal registered stress). */
export function timing(px: number[], ep: Episode, clearAt: (i: number) => boolean | null, mode: "after-stress" | "first"): Cell {
  let armed = mode === "first";
  for (let i = ep.start; i <= ep.end; i++) {
    const ok = clearAt(i);
    if (ok !== true) { armed = true; continue; }
    if (!armed) continue;
    const further = Math.min(...px.slice(i, ep.end + 1)) / px[i]! - 1;
    return { at: i, lag: i - ep.trough, vsTrough: px[i]! / px[ep.trough]! - 1, further };
  }
  return null;
}

const pc = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
export const cellText = (c: Cell): string => (c === null ? "never" : `${c.lag >= 0 ? "+" : ""}${c.lag}d ${pc(c.vsTrough)} dd${pc(c.further)}`);

/** Vol knobs: bad/bear = a further ≤ −FURTHER fall; VXNT = VXN / (VIX3M × median VXN/VIX over MED_N prior VIX3M closes). */
export const VOL = { FURTHER: 0.15, MED_N: 250, MA_N: 50, P80: 0.8, FLIP_W: 20, FLIP_RUN: 3, GATE_N: [5, 10, 20] } as const;
type Opt = (number | null)[];
/** On the VIX ∩ VXN calendar; `vt` = VIX/VIX3M. */
export type Vol = { dates: string[]; vix: number[]; vxn: number[]; vt: Opt; vxnt: Opt; vixMed: Opt; vxnMed: Opt; vixMa: Opt; ratio: number[]; ratio80: Opt };
const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const pctile = (a: number[], q: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
const trail = (v: number[], f: (w: number[]) => number, n: number): Opt => v.map((_, i) => (i >= n - 1 ? f(v.slice(i - n + 1, i + 1)) : null));

export function volOf(vixS: Series, vix3mS: Series, vxnS: Series): Vol {
  const m3 = new Map(vix3mS.map((p) => [p.date, p.value])), mx = new Map(vxnS.map((p) => [p.date, p.value]));
  const cal = vixS.filter((p) => mx.has(p.date));
  const [dates, vix] = [cal.map((p) => p.date), cal.map((p) => p.value)];
  const vxn = dates.map((d) => mx.get(d)!), v3 = dates.map((d) => m3.get(d) ?? null);
  const ratio = vxn.map((x, i) => x / vix[i]!);
  const vxnt = dates.map((_, i) => {
    const prior: number[] = [];
    for (let j = i - 1; v3[i] !== null && j >= 0 && prior.length < VOL.MED_N; j--) if (v3[j] !== null) prior.push(ratio[j]!);
    return prior.length < VOL.MED_N ? null : vxn[i]! / (v3[i]! * median(prior));
  });
  return {
    dates, vix, vxn, vxnt, ratio,
    vt: vix.map((x, i) => (v3[i] === null ? null : x / v3[i]!)),
    vixMed: trail(vix, median, VOL.MED_N), vxnMed: trail(vxn, median, VOL.MED_N),
    vixMa: trail(vix, (w) => w.reduce((a, b) => a + b, 0) / w.length, VOL.MA_N),
    ratio80: ratio.map((_, i) => (i >= VOL.MED_N ? pctile(ratio.slice(i - VOL.MED_N, i), VOL.P80) : null)),
  };
}

/** `peak` = max VIX from the episode's pre-entry high to this close (gate rules only). */
export type VolRule = { id: string; role: string; on: (v: Vol, i: number, peak: number | null) => boolean | null };
const EPS = 1e-9;
const lastK = (s: Opt, i: number, k: number, ok: (x: number) => boolean): number | null => {
  if (i - k + 1 < 0) return null;
  let n = 0;
  for (let j = i - k + 1; j <= i; j++) { if (s[j] === null) return null; if (ok(s[j]!)) n++; }
  return n;
};
const atLeast = (s: (v: Vol) => Opt, k: number, m: number, ok: (x: number) => boolean): VolRule["on"] => (v, i) => ((n) => (n === null ? null : n >= m))(lastK(s(v), i, k, ok));
const run = (s: (v: Vol) => Opt, k: number, cut: number): VolRule["on"] => atLeast(s, k, k, (x) => x >= cut - EPS);
const cmp = (x: (v: Vol) => Opt | number[], y: (v: Vol) => Opt, k: number, gt: boolean): VolRule["on"] => (v, i) => {
  const [a, b] = [x(v)[i], y(v)[i]];
  return a === null || a === undefined || b === null || b === undefined ? null : gt ? a > k * b : a < k * b;
};
const lvl = (s: (v: Vol) => Opt | number[], k: number, gt: boolean): VolRule["on"] => (v, i) => ((a) => (a === null || a === undefined ? null : gt ? a > k : a < k))(s(v)[i]);
/** VT < 1 after ≥ FLIP_RUN closes ≥ 1. */
export const flipAt = (vt: Opt, j: number): boolean | null => {
  if (j < VOL.FLIP_RUN || vt[j] === null) return null;
  if (!(vt[j]! < 1)) return false;
  for (let k = 1; k <= VOL.FLIP_RUN; k++) if (vt[j - k] === null || vt[j - k]! < 1 - EPS) return false;
  return true;
};
const [VT, VXNT, VIX, VXN] = [(v: Vol) => v.vt, (v: Vol) => v.vxnt, (v: Vol) => v.vix, (v: Vol) => v.vxn];
/** Box holds (ON = stress), reviewed in the Semis vol-gates review. */
export const VOL_BOX: readonly VolRule[] = [
  { id: `VT≥${SEMIS_RULES.ESC_VT} ×${SEMIS_RULES.ESC_VOL_FLIP_N}`, role: "box vol_flip (shipped)", on: run(VT, SEMIS_RULES.ESC_VOL_FLIP_N, SEMIS_RULES.ESC_VT) },
  { id: "VT≥1 ×10", role: "pre-V2 cut", on: run(VT, 10, 1) },
  { id: "VT≥1 ×5", role: "candidate", on: run(VT, 5, 1) },
  { id: "VT≥1 any/10", role: "candidate", on: atLeast(VT, 10, 1, (x) => x >= 1 - EPS) },
  { id: "VT≥1 ≥5/10", role: "candidate", on: atLeast(VT, 10, 5, (x) => x >= 1 - EPS) },
  { id: "VT≥0.95 ×10", role: "candidate", on: run(VT, 10, 0.95) },
  { id: "VXNT≥1 ×10", role: "candidate", on: run(VXNT, 10, 1) },
  { id: "VXNT≥1 ×5", role: "candidate", on: run(VXNT, 5, 1) },
  { id: `VXN>${SEMIS_RULES.ESC_VOL_MED_K}×med`, role: "sign vxn (retired 2026-10-25)", on: cmp(VXN, (v) => v.vxnMed, SEMIS_RULES.ESC_VOL_MED_K, true) },
  { id: "VXN>1.3×med", role: "candidate", on: cmp(VXN, (v) => v.vxnMed, 1.3, true) },
  { id: "VXN>1.5×med", role: "candidate", on: cmp(VXN, (v) => v.vxnMed, 1.5, true) },
  { id: "VIX>30", role: "candidate", on: lvl(VIX, 30, true) },
  { id: "VIX>1.2×med", role: "candidate", on: cmp(VIX, (v) => v.vixMed, 1.2, true) },
  { id: "VIX>1.5×med", role: "candidate", on: cmp(VIX, (v) => v.vixMed, 1.5, true) },
  { id: "VXN/VIX>p80", role: "candidate", on: cmp((v) => v.ratio, (v) => v.ratio80, 1, true) },
];
const offPeak = (k: number): VolRule["on"] => (v, i, peak) => (peak === null ? null : v.vix[i]! <= k * peak);
/** Tranche gates (true = allow, calm). */
export const VOL_GATES: readonly VolRule[] = [
  { id: "VT<1", role: "gate", on: lvl(VT, 1, false) },
  { id: "VT<0.95", role: "gate", on: lvl(VT, 0.95, false) },
  { id: "VT<0.9", role: "gate", on: lvl(VT, 0.9, false) },
  { id: "VIX<20", role: "gate", on: lvl(VIX, 20, false) },
  { id: "VIX<25", role: "gate", on: lvl(VIX, 25, false) },
  { id: "VIX<MA50", role: "gate (V4)", on: cmp(VIX, (v) => v.vixMa, 1, false) },
  { id: "VIX≤0.8×epPeak", role: "gate", on: offPeak(0.8) },
  { id: "VIX≤0.67×epPeak", role: "gate", on: offPeak(0.67) },
  { id: "VXN<1.2×med", role: "gate", on: cmp(VXN, (v) => v.vxnMed, 1.2, false) },
  { id: "VXNT<1", role: "gate", on: lvl(VXNT, 1, false) },
  { id: "VXNT<0.95", role: "gate", on: lvl(VXNT, 0.95, false) },
  { id: `VT flip<1 ≤${VOL.FLIP_W}d`, role: "gate", on: (v, i) => {
    if (v.vt[i] === null) return null;
    for (let j = i; j > i - VOL.FLIP_W && j >= 0; j--) if (flipAt(v.vt, j)) return v.vt[i]! < 1;
    return false;
  } },
];

/** `pk` = the pre-entry high (argmax over the 250 closes to entry); bear = trough ≤ −FURTHER below the entry close. */
export type VolEp = Episode & { pk: number; bear: boolean };
export const volEpisodes = (px: number[]): VolEp[] => episodesOf(px).map((e) => {
  let pk = Math.max(0, e.start - (TURN.HIGH_N - 1));
  for (let j = pk; j <= e.start; j++) if (px[j]! > px[pk]!) pk = j;
  return { ...e, pk, bear: px[e.trough]! / px[e.start]! - 1 <= -VOL.FURTHER };
});
const furtherAt = (px: number[], e: Episode, i: number): number => Math.min(...px.slice(i, e.end + 1)) / px[i]! - 1;

/** Box-hold read over `set`: `on(si)` on the price calendar. */
export function holdStats(px: number[], set: VolEp[], on: (si: number) => boolean | null) {
  const s = { on: 0, good: 0, post: [] as number[], perEp: [] as number[], bear: 0, fizzle: 0, outside: 0 };
  const inSet = new Set<number>();
  for (const e of set) {
    let [n, p] = [0, 0];
    for (let i = e.start; i <= e.end; i++) {
      inSet.add(i);
      if (on(i) !== true) continue;
      n++;
      if (furtherAt(px, e, i) <= -VOL.FURTHER) s.good++;
      if (i > e.trough) p++;
    }
    s.on += n; s.post.push(p); s.perEp.push(n); s[e.bear ? "bear" : "fizzle"] += n;
  }
  for (let i = set[0]?.start ?? px.length; i < px.length; i++) if (!inSet.has(i) && on(i) === true) s.outside++;
  return s;
}

/** Candidates = in-episode closes ≥ n after the running low; bad = a further ≤ −FURTHER fall; non-true blocks. */
export function gateStats(px: number[], set: VolEp[], n: number, allow: (si: number, e: VolEp) => boolean | null) {
  const s = { bad: 0, good: 0, badBlocked: 0, goodBlocked: 0, allowed: 0, badAllowed: 0, badAllowedPerEp: set.map(() => 0) };
  set.forEach((e, k) => {
    let lo = e.start;
    for (let i = e.start; i <= e.end; i++) {
      if (px[i]! < px[lo]!) lo = i;
      if (i - lo < n) continue;
      const bad = furtherAt(px, e, i) <= -VOL.FURTHER;
      s[bad ? "bad" : "good"]++;
      if (allow(i, e) !== true) s[bad ? "badBlocked" : "goodBlocked"]++;
      else { s.allowed++; if (bad) { s.badAllowed++; s.badAllowedPerEp[k]!++; } }
    }
  });
  return s;
}

const pp = (x: number): string => `${(x * 100).toFixed(0)}%`;
function volMain(price: Series, signalPath: string): void {
  const dir = signalPath.slice(0, signalPath.lastIndexOf("/") + 1);
  const v = volOf(readCsv(signalPath), readCsv(`${dir}vix3m.csv`), readCsv(`${dir}vxn.csv`));
  const [px, sd] = [price.map((p) => p.value), price.map((p) => p.date)];
  const vIdx = new Map(v.dates.map((d, i) => [d, i]));
  const at = (r: VolRule, si: number, peak: number | null = null) => ((vi) => (vi === undefined ? null : r.on(v, vi, peak)))(vIdx.get(sd[si]!));
  const set = volEpisodes(px).filter((e) => ((vi) => vi !== undefined && v.vxnt[vi] !== null)(vIdx.get(sd[e.start]!)));
  const tag = set.map((e) => sd[e.trough]!.slice(0, 7));
  const peakAt = (si: number, e: VolEp): number | null => {
    let m: number | null = null;
    for (let j = e.pk; j <= si; j++) { const vi = vIdx.get(sd[j]!); if (vi !== undefined) m = Math.max(m ?? 0, v.vix[vi]!); }
    return m;
  };
  console.log(`turn-timing vol · ${v.dates[0]} → ${v.dates.at(-1)} × ${sd[0]} → ${sd.at(-1)} · episodes with VXNT at entry:`);
  set.forEach((e, k) => console.log(`  ${tag[k]} ${sd[e.pk]} → entry ${sd[e.start]} → trough ${sd[e.trough]} → ${sd[e.end]}${e.open ? " (open)" : ""} · ${e.bear ? "bear" : "fizzle"}`));
  console.log(`\nbox hold | ON days | P(further≤−${pp(VOL.FURTHER)}|ON) | post-trough ON (${tag.join("/")}) | votes in | ON bear/fizzle | ON outside episodes`);
  for (const r of VOL_BOX) {
    const s = holdStats(px, set, (si) => at(r, si));
    const votes = tag.filter((_, k) => s.perEp[k]! > 0).join(",");
    console.log(`${r.id.padEnd(12)} ${r.role.padEnd(22)} | ${s.on} | ${s.on ? pp(s.good / s.on) : "—"} | ${s.post.join("/")} | ${votes} | ${s.bear}/${s.fizzle} | ${s.outside}`);
  }
  for (const n of VOL.GATE_N) {
    const head = gateStats(px, set, n, () => true);
    const base = pp(head.bad / (head.bad + head.good));
    console.log(`\ngate (allow when calm), candidate ≥${n} closes after the running low (bad ${head.bad}, good ${head.good}, base P(bad) ${base}) | bad blocked | good blocked | P(bad|allowed) | bad allowed per ep`);
    for (const r of VOL_GATES) {
      const s = gateStats(px, set, n, (si, e) => at(r, si, peakAt(si, e)));
      const per = s.badAllowedPerEp.map((x, k) => (x ? `${tag[k]}:${x}` : "")).filter(Boolean).join(" ") || "—";
      console.log(`${r.id.padEnd(16)} | ${pp(s.badBlocked / s.bad)} | ${pp(s.goodBlocked / s.good)} | ${s.allowed ? pp(s.badAllowed / s.allowed) : "—"} (n=${s.allowed}) | ${per}`);
    }
  }
}

function main(): void {
  const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const mode = arg("mode") === "first" ? "first" : "after-stress";
  const price = readCsv(arg("price") ?? "scripts/backtest/data/smh_adj.csv");
  if (/(^|\/)vix\.csv$/.test(arg("signal") ?? "")) return volMain(price, arg("signal")!);
  const signal = arg("signal") ? readCsv(arg("signal")!) : stitch(readCsv("data/BAMLH0A0HYM2-vintage.csv"), readCsv("scripts/backtest/data/hyoas.csv"));
  const { dates, px, sg } = align(price, signal);
  const shocks = new Map<number, ReturnType<typeof shockOf>>();
  const pts: Pt[] = dates.map((date, j) => ({ date, value: sg[j]! }));
  const shock = (i: number) => (shocks.has(i) ? shocks.get(i)! : ((s) => (shocks.set(i, s), s))(shockOf(pts.slice(0, i + 1), SHOCK)));
  const eps = episodesOf(px).filter((e) => e.start >= TURN.WARMUP);
  console.log(`turn-timing · ${dates[0]} → ${dates.at(-1)} · mode ${mode} · episodes (entry ≤ −${TURN.ENTER * 100}%, trough ≤ −${TURN.DEPTH * 100}%):`);
  eps.forEach((e, n) => {
    const w = sg.slice(Math.max(0, e.start - 60), Math.min(sg.length, e.trough + 120));
    const pk = Math.max(0, e.start - 60) + w.indexOf(Math.max(...w));
    console.log(`  E${n + 1} ${dates[e.start]} trough ${dates[e.trough]}${e.open ? " (open)" : ""} · signal peak ${dates[pk]} ${sg[pk]} (${pk - e.trough >= 0 ? "+" : ""}${pk - e.trough}d vs trough)`);
  });
  for (const r of RULES) {
    const cells = eps.map((e) => timing(px, e, (i) => r.clear({ v: sg, i, start: e.start, dates, pts, shock }), mode));
    console.log(`${r.id.padEnd(12)} ${r.role.padEnd(34)} | ${cells.map(cellText).join(" | ")}`);
  }
}
if (process.argv[1]?.endsWith("turn-timing.ts")) main();
