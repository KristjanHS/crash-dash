// crash-dash — replay-driven scoreboard (dev tool, D9×2b): chains a hypothetical
// SB_STRAT/SB_BENCH NAV pair from the prod replay leg-path and prints the full
// computeScoreboard view over it. READ-ONLY — never writes SB_* rows, so the live
// out-of-sample kill-gate chain stays untouched. The strategy leg is the RAW dial
// pick (replay `targetRung`), WITHOUT the live held-pick inertia (deadband / dwell /
// re-risk confirm) — more whipsaw-prone than the live prescription, but consistent
// across selection-logic variants, which is what this tool compares.
//
// Usage: npx tsx scripts/replay-scoreboard.ts YYYY-MM-DD:YYYY-MM-DD
// NB: computeScoreboard windows to the last SCOREBOARD_WINDOW (400) points — a longer
// range still replays fully but the metrics cover its tail (mirrors the live card).

import type { Observation } from "../src/domain-types.js";
import { LADDER } from "../src/families.js";
import { fetchDailyCloses } from "../src/prices.js";
import type { R4Phase } from "../src/r4.js";
import {
  chainedRatio,
  computeScoreboard,
  LEG_TICKER,
  NAV_BASE,
  nextNav,
  SCOREBOARD_WINDOW,
  type LegQuote,
  type NavPoint,
  type ScoreboardAlertRow,
} from "../src/scoreboard.js";
import { readEnv } from "../src/config.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

const env = readEnv();

interface ReplayPoint {
  date: string;
  targetRung: number;
  r4Phase: R4Phase;
  cash: boolean;
}

const range = process.argv[2] ?? "";
if (!/^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(range)) {
  console.error("usage: npx tsx scripts/replay-scoreboard.ts YYYY-MM-DD:YYYY-MM-DD");
  process.exit(1);
}

const res = await fetch(`${prodBaseUrl()}/api/lab?replay=${range}`);
const body = (await res.json()) as { error?: string; points?: ReplayPoint[]; notes?: string[] };
if (!res.ok || body.points === undefined) {
  console.error(`replay fetch failed: ${body.error ?? res.status}`);
  process.exit(1);
}
const points = body.points;
if (points.length < 2) {
  console.error(`only ${points.length} replay points — nothing to chain`);
  process.exit(1);
}

// One deep fetch per distinct leg visited + benchmark + FX (all keyless-reachable).
const sleeves = [...new Set(points.map((p) => LADDER[p.targetRung - 1]!))];
const tickers = [...new Set(sleeves.map((s) => LEG_TICKER[s].ticker))];
const [fx, acwi, ...legSeries] = await Promise.all([
  fetchDailyCloses("EURUSD=X", { deep: true, now: Date.now, env }),
  fetchDailyCloses("ACWI", { deep: true, now: Date.now, env }),
  ...tickers.map((t) => fetchDailyCloses(t, { deep: true, now: Date.now, env })),
]);
// Align each close series to the replay date axis (nearest prior close within 7
// calendar days, else absent) — the replay engine's own forward-fill idiom, scaled to
// price feeds. Without this the EU-listed legs (.DE/.L calendars) miss exact-date
// lookups on the US/FRED-driven axis, and a single missing ANCHOR date would stall
// the chain forever (the anchor only advances on a successful step).
function alignToDates(closes: Observation[], dates: string[]): Observation[] {
  const out: Observation[] = [];
  let i = -1;
  for (const d of dates) {
    while (i + 1 < closes.length && closes[i + 1]!.date <= d) i++;
    if (i < 0) continue;
    const p = closes[i]!;
    if (Date.parse(d) - Date.parse(p.date) <= 7 * 86_400_000) out.push({ date: d, value: p.value });
  }
  return out;
}
const axis = points.map((p) => p.date);
const acwiAligned = alignToDates(acwi, axis);
const closesByTicker = new Map<string, Observation[]>(tickers.map((t, i) => [t, alignToDates(legSeries[i]!, axis)]));

// Chain both NAVs across the replay dates. Replay's axis is the union of INDICATOR
// observation dates, so a leg/bench ETF can lack a close on some dates (holidays,
// FRED-only days) — those days are skipped and the next successful step absorbs the
// span as a multi-day ratio (the live chain's own gap semantics, incl. its accepted
// approximation: the whole span is attributed to the anchor day's prescription).
const strat: NavPoint[] = [{ date: points[0]!.date, value: NAV_BASE }];
const bench: NavPoint[] = [{ date: points[0]!.date, value: NAV_BASE }];
let anchor = points[0]!;
let skipped = 0;
const skipReasons = new Map<string, number>();
for (const p of points.slice(1)) {
  const held = LADDER[anchor.targetRung - 1]!;
  const leg: LegQuote = LEG_TICKER[held];
  try {
    const benchNav = bench.at(-1)!.value * chainedRatio(acwiAligned, fx, anchor.date, p.date, "USD");
    const stratNav = nextNav(strat.at(-1)!.value, closesByTicker.get(leg.ticker)!, fx, anchor.date, p.date, {
      heldSleeve: held,
      r4Phase: anchor.r4Phase,
    });
    strat.push({ date: p.date, value: stratNav });
    bench.push({ date: p.date, value: benchNav });
    anchor = p;
  } catch (err) {
    skipped++;
    const key = String(err instanceof Error ? err.message : err).replace(/\d{4}-\d{2}-\d{2}/, "<date>");
    skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
  }
}

const alerts: ScoreboardAlertRow[] = points.map((p) => ({ date: p.date, r4Phase: p.r4Phase }));
const now = new Date(`${points.at(-1)!.date}T00:00:00Z`); // trailing-365d windows end at the replay's end, not wall-clock
const scoreboard = computeScoreboard(strat, bench, [], alerts, now);

console.log(
  JSON.stringify(
    {
      range,
      replayPoints: points.length,
      chained: strat.length,
      skippedDates: skipped,
      skipReasons: Object.fromEntries(skipReasons),
      metricsWindow: Math.min(strat.length, SCOREBOARD_WINDOW),
      legsVisited: sleeves,
      finalNav: { strategy: strat.at(-1)!.value, benchmark: bench.at(-1)!.value },
      replayNotes: body.notes ?? [],
      scoreboard,
    },
    null,
    2,
  ),
);
