/**
 * probe-disp-gate.ts — measures whether DISP's correlation CONFIRM gate (`DISP_CORR`, strict `>`)
 * actually binds, and how the alternative "standardized shift" severity form would behave.
 * READ-ONLY: price feeds only, no store, no writes.
 *
 * Three questions, in the order they decide the redesign:
 *   Q1 GATE INERTIA — over the deep history, what share of days clear `meanCorr > DISP_CORR`?
 *      A gate that is on ~always (or off ~always) contributes nothing: DISP degenerates to a
 *      pure 20d-basket-return trigger. Reported as the corr percentile grid + the share of
 *      NEGATIVE-basket days the gate BLOCKED (those are the only days it can change an outcome).
 *   Q2 LEAD vs COINCIDENCE — mean forward basket return after each raw state, at +5/+20/+60d.
 *      The current design triggers on a REALIZED 20d fall; a leading signal should show a
 *      NEGATIVE forward return, not merely a negative trailing one.
 *   Q3 SHIFT FORM — Kritzman et al.'s standardized shift, transplanted onto meanCorr:
 *      (MA(corr, SHORT) − MA(corr, LONG)) / sd(corr, LONG). Same forward-return table, so the
 *      two forms are compared on the SAME days and the same metric.
 *
 * Usage:  npx tsx scripts/probe-disp-gate.ts            (default 10y of closes)
 *         npx tsx scripts/probe-disp-gate.ts --years=15
 */
import { fetchDailyCloses } from "../src/prices.js";
import { dispersionReadingSeries } from "../src/scorers-composite.js";
import { DISP_CORR, DISP_BASKET_RED } from "../src/family-descriptor-rows.js";
import { DISP } from "../src/registry-composite.js";
import { alignByDates } from "../src/scorers-core.js";
import { argOf } from "./lib/cli.js";
import { readEnv } from "../src/config.js";

const YEARS = Number(argOf("years") ?? 10);
const SHORT = 15; // Kritzman's 15-day AR leg, transplanted onto meanCorr
const LONG = 252; // ... against its one-year leg + one-year sd
const HORIZONS = [5, 20, 60];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "  n/a");
const fpc = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "  n/a");

const main = async () => {
  const env = readEnv();
  const lookbackDays = Math.round(YEARS * 365.25);
  const [spy, fez, eem] = await Promise.all(
    ["SPY", "FEZ", "EEM"].map((s) => fetchDailyCloses(s, { deep: true, lookbackDays, now: Date.now, env })),
  );
  const series = dispersionReadingSeries(DISP, spy!, fez!, eem!);
  if (!series.length) throw new Error("no DISP readings built — feed too short or degenerate");

  // Forward basket path: recompute the equal-weight basket level on the SAME aligned dates the
  // reading series was built from, so index i of `series` lines up with index i+offset here.
  const { dates, values } = alignByDates([spy!, fez!, eem!]);
  const [s, f, e] = values;
  const basketLevel = s!.map((_, i) => (s![i]! / s![0]! + f![i]! / f![0]! + e![i]! / e![0]!) / 3);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));

  const fwd = (date: string, h: number): number | null => {
    const i = dateIdx.get(date);
    if (i === undefined || i + h >= basketLevel.length) return null;
    return basketLevel[i + h]! / basketLevel[i]! - 1;
  };

  const corr = series.map((r) => r.level);
  const basket = series.map((r) => (r.decision ?? NaN));

  console.log(`\n== probe-disp-gate — ${series.length} scored days, ${series[0]!.date} → ${series.at(-1)!.date} ==`);
  console.log(`   DISP_CORR=${DISP_CORR} (strict >)   DISP_BASKET_RED=${DISP_BASKET_RED}\n`);

  // --- Q1: gate inertia ------------------------------------------------------
  console.log(`-- Q1  meanCorr distribution (the gated axis) --`);
  console.log(`   p01 ${f2(pct(corr, 1))}  p10 ${f2(pct(corr, 10))}  p25 ${f2(pct(corr, 25))}  ` +
    `p50 ${f2(pct(corr, 50))}  p75 ${f2(pct(corr, 75))}  p90 ${f2(pct(corr, 90))}  p99 ${f2(pct(corr, 99))}`);
  const on = corr.filter((c) => c > DISP_CORR).length;
  console.log(`   days clearing the gate: ${on}/${corr.length} = ${fpc(on / corr.length)}`);
  const negIdx = basket.map((b, i) => (b < 0 ? i : -1)).filter((i) => i >= 0);
  const blocked = negIdx.filter((i) => !(corr[i]! > DISP_CORR));
  console.log(`   negative-basket days: ${negIdx.length}   of those BLOCKED by the gate: ` +
    `${blocked.length} = ${fpc(blocked.length / Math.max(1, negIdx.length))}`);
  console.log(`   ^ the gate can only change an outcome on those blocked days; ~0% or ~100% ⇒ inert.\n`);

  // --- Q2: current form, lead vs coincidence ---------------------------------
  const rows: Array<[string, number[]]> = [
    ["GREEN", []],
    ["AMBER", []],
    ["RED", []],
  ];
  console.log(`-- Q2  forward basket return by CURRENT raw state (trigger = realized 20d fall) --`);
  console.log(`   state    n      trailing20d     +5d       +20d      +60d`);
  for (const st of ["GREEN", "AMBER", "RED"] as const) {
    const idx = series.map((r, i) => (r.state === st ? i : -1)).filter((i) => i >= 0);
    const tr = idx.map((i) => basket[i]!).filter(Number.isFinite);
    const cells = HORIZONS.map((h) => mean(idx.map((i) => fwd(series[i]!.date, h)).filter((x): x is number => x !== null)));
    console.log(`   ${st.padEnd(6)} ${String(idx.length).padStart(5)}   ${fpc(mean(tr)).padStart(10)}` +
      cells.map((c) => fpc(c).padStart(10)).join(""));
    void rows;
  }
  console.log(`   ^ a LEADING signal wants the +20d/+60d cells negative, not just the trailing one.\n`);

  // --- Q3: standardized-shift form -------------------------------------------
  console.log(`-- Q3  standardized shift of meanCorr:  (MA${SHORT} − MA${LONG}) / sd${LONG}  --`);
  const shift: (number | null)[] = corr.map((_, i) => {
    if (i < LONG) return null;
    const longWin = corr.slice(i - LONG + 1, i + 1);
    const shortWin = corr.slice(i - SHORT + 1, i + 1);
    const s2 = sd(longWin);
    return s2 > 0 ? (mean(shortWin) - mean(longWin)) / s2 : null;
  });
  const live = shift.filter((x): x is number => x !== null);
  console.log(`   shift distribution: p10 ${f2(pct(live, 10))}  p50 ${f2(pct(live, 50))}  ` +
    `p75 ${f2(pct(live, 75))}  p90 ${f2(pct(live, 90))}  p95 ${f2(pct(live, 95))}  p99 ${f2(pct(live, 99))}`);
  console.log(`\n   bucket        n      +5d       +20d      +60d`);
  const buckets: Array<[string, (x: number) => boolean]> = [
    ["shift<0   ", (x) => x < 0],
    ["0..+1σ    ", (x) => x >= 0 && x < 1],
    ["+1..+2σ   ", (x) => x >= 1 && x < 2],
    ["≥+2σ      ", (x) => x >= 2],
  ];
  for (const [label, test] of buckets) {
    const idx = shift.map((x, i) => (x !== null && test(x) ? i : -1)).filter((i) => i >= 0);
    const cells = HORIZONS.map((h) => mean(idx.map((i) => fwd(series[i]!.date, h)).filter((x): x is number => x !== null)));
    console.log(`   ${label} ${String(idx.length).padStart(5)}` + cells.map((c) => fpc(c).padStart(10)).join(""));
  }
  console.log(`\n   ^ Kritzman's claim: a positive standardized SHIFT precedes losses. If the +1..+2σ and`);
  console.log(`     ≥+2σ rows are negative at +20d/+60d WITHOUT needing a realized fall, the shift form`);
  console.log(`     leads where the current trigger merely coincides.\n`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
