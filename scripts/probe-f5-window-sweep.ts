/**
 * probe-f5-window-sweep.ts — does F5's GREEN today come from the market, or from the band's shape?
 *
 * The question this answers (asked 2026-08-30): prod F5 sits ~7pp below its rolling AMBER cut, which
 * reads as "very peaceful". Is that the market, or an artifact of the `BREADTH_BAND` triple
 * (`highWindow`, `amberP`/`redP`, `cutWindow`)? The sweep re-scores the SAME QQQ/QQQE history under a
 * grid of candidate triples and prints, per candidate: the raw per-day duty cycle over the whole
 * fixture, and what the LATEST fixture day would score. A candidate that still says GREEN today has
 * no earlier warning to give at this parameter; one that fires today is buying it with duty cycle.
 *
 * ── WHAT IT CALLS (shipped code, never re-derived) ──────────────────────────────────
 *   `breadthDistSeries` / `breadthCutSeries` / `breadthClassify` — the exact internals
 *   `breadthReadingSeries` runs on the live F5 route. The sweep varies ONLY the three parameters;
 *   the ratio and the classify order are the shipped expressions. The SHIPPED triple is a grid row
 *   read from `BREADTH_BAND`, marked `<- shipped`, never re-typed (`indicator-loop.md` §A retune is a ONE-place edit).
 *
 * Offline: reads the committed `scripts/backtest/data/{qqq,qqqe}.csv` fixtures through the harness's
 * own `readCsv`, so it needs no feed key and no store. REPORT ONLY — edits nothing.
 *
 * ⚠ Duty cycle is the RAW per-day band (pre-fold), the same measure `probe:f5-band` reports, so the
 *   two are comparable. The fixture ends at its own left/right edges — the printed span is the whole
 *   claim; do not read a "today" row as prod's latest close unless the dates match.
 *
 * Usage: npx tsx scripts/probe-f5-window-sweep.ts
 */
import { readCsv } from "./backtest/derive.js";
import { BREADTH_BAND, PRICE_WINDOWS } from "../src/family-descriptor-rows.js";
import { alignByDate } from "../src/scorers-core.js";
import { breadthDistSeries, breadthCutSeries, breadthClassify } from "../src/scorers-price.js";
import type { State } from "../src/domain-types.js";

const qqq = readCsv("qqq");
const qqqe = readCsv("qqqe");
const { dates, a, b } = alignByDate(qqq, qqqe);
const ratio = a.map((v, i) => v / b[i]!);

const pct = (x: number) => (x * 100).toFixed(2);

type Cand = { highWindow: number; amberP: number; redP: number; cutWindow: number };
const SHIPPED: Cand = {
  highWindow: BREADTH_BAND.highWindow,
  amberP: BREADTH_BAND.amberP,
  redP: BREADTH_BAND.redP,
  cutWindow: BREADTH_BAND.cutWindow,
};

const grid: Cand[] = [SHIPPED];
for (const highWindow of [PRICE_WINDOWS.high, PRICE_WINDOWS.highShort, 126]) {
  for (const cutWindow of [63, 126, 252]) {
    for (const [amberP, redP] of [[0.7, 0.9], [0.8, 0.95], [0.85, 0.98]] as const) {
      grid.push({ highWindow, amberP, redP, cutWindow });
    }
  }
}

const isShipped = (c: Cand) =>
  c.highWindow === SHIPPED.highWindow && c.cutWindow === SHIPPED.cutWindow &&
  c.amberP === SHIPPED.amberP && c.redP === SHIPPED.redP;

console.log(`F5 QQQ/QQQE window sweep — ${dates[0]} → ${dates.at(-1)} (${dates.length} aligned closes)`);
console.log(
  "\nhigh  cut   amber/red |  AMBER%  RED%  | today: dist    amberCut  redCut   state  gap-to-amber",
);
const seen = new Set<string>();
for (const c of grid) {
  const key = `${c.highWindow}|${c.cutWindow}|${c.amberP}|${c.redP}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const dist = breadthDistSeries(ratio, c.highWindow);
  const amberCut = breadthCutSeries(dist, c.amberP, c.cutWindow, c.cutWindow);
  const redCut = breadthCutSeries(dist, c.redP, c.cutWindow, c.cutWindow);
  let amber = 0, red = 0, scored = 0;
  for (let i = 0; i < dist.length; i++) {
    if (!Number.isFinite(dist[i]!) || !Number.isFinite(redCut[i]!)) continue;
    scored++;
    const s: State = breadthClassify(i, dist, amberCut, redCut, BREADTH_BAND.direction);
    if (s === "RED") red++;
    else if (s === "AMBER") amber++;
  }
  const i = dist.length - 1;
  const s = breadthClassify(i, dist, amberCut, redCut, BREADTH_BAND.direction);
  const gap = dist[i]! - amberCut[i]!;
  console.log(
    `${String(c.highWindow).padStart(4)} ${String(c.cutWindow).padStart(4)}  ` +
      `p${(c.amberP * 100).toFixed(0)}/p${(c.redP * 100).toFixed(0)}`.padEnd(10) +
      `| ${(amber / scored * 100).toFixed(1).padStart(5)}% ${(red / scored * 100).toFixed(1).padStart(5)}% ` +
      `| ${pct(dist[i]!).padStart(7)}%  ${pct(amberCut[i]!).padStart(7)}%  ${pct(redCut[i]!).padStart(7)}%  ` +
      `${s.padEnd(6)} ${pct(gap).padStart(7)}pp` +
      (isShipped(c) ? "   <- shipped" : ""),
  );
}
