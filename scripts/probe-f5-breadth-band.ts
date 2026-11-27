/**
 * probe-f5-breadth-band.ts —
 * the fire-rate evidence Stage 5's `[USER]` cut ruling is decided on.
 *
 *   npm run probe:f5-band   # = bash scripts/with-prod-config.sh tsx scripts/probe-f5-breadth-band.ts --env=prod
 *   npm run probe:f5-band
 *
 * WHAT IT MEASURES. F5 (`QQQ/QQQE` breadth) and SPCONC (`SPY/RSP` concentration) gained their FIRST
 * crossable band in Stages 1–2b: a full rolling-percentile band on the STRICT-PRIOR
 * distance-from-12-mo-high, firing HIGH-ward off the `BREADTH_*` triple. Those probabilities are read from the
 * option preview the user picked, never a calibrated value (`docs/reference.md` §[arch] 4). This probe
 * turns them into duty-cycle numbers — how often each level actually fires over the board's own stored
 * history — plus the latest cut values in ratio-distance units, so the user re-sets the pair off real
 * fire-rates rather than off a probability that sounds reasonable.
 *
 * IT CALLS THE SHIPPED SCORER VERBATIM (S4-R3).
 * `breadthReadingSeries(indicator, qqq, qqqe)` takes the two Observation LEGS, not the ratio, and prod stores
 * the RATIO (`readings.value`). So the stored ratio is fed as `a = ratio, b = 1` per date: `alignByDate` over
 * two identical date arrays is the identity, and the scorer's own `q.map((v, i) => v / e[i]!)` reproduces the
 * stored ratio exactly. `breadthDistSeries`, `breadthCutSeries` and the RED-before-AMBER classify order are
 * therefore the ONE live expression (`indicator-loop.md` §A retune is a ONE-place edit) — this probe cannot drift from the
 * board, and re-deriving `dist` or its cuts locally would be a defect, not a shortcut. The cut PROBABILITIES
 * and windows are likewise read off each id's own `BREADTH_CONFIG_OF` row, never re-typed, so a retune of
 * either id moves this report with no second edit.
 *
 * WHY THE REGIME SPLIT IS REPORTED, AND WHY IT BEARS ON THE RULING. Measured during Stage 1: a UNIFORM
 * climb to fresh highs does NOT redden this band. The rolling percentile ranks each day against its
 * own prior climb-day distribution, so persistent new highs sit near the MEDIAN of that distribution;
 * only an OUTLIER jump above the RED cut of prior `dist` reddens, and only the latest day drives the
 * confirmed state. The band detects breakout ACCELERATION, not a sustained concentration regime. Two
 * statistics make that visible instead of merely asserted, both computed on the same `dist` array the
 * scorer classified: (i) RED episode RUN-LENGTH — a regime detector shows long runs, an acceleration
 * detector shows runs of 1–2 closes; (ii) RED days split into JUMP days (`dist[i] − dist[i−1]` at or
 * above the p90 of the `|Δdist|` distribution) versus TREND days (the rest).
 *
 * ⚠ THE FIRST PROD RUN PARTLY REFUTES THE STAGE-1 FRAMING, so do not read this probe as confirming it.
 * 2026-08-20 on prod: RED runs ARE short (mean 2.06 F5 / 2.66 SPCONC), but RED is NOT concentrated in
 * JUMP days — F5 40 JUMP vs 139 TREND, SPCONC 26 vs 229, and the max run reaches 10 / 24 closes. So the
 * state does not persist, yet most RED days are ordinary drift across a cut that crept down rather than
 * outlier accelerations. "Acceleration, not regime" holds only for the run-length half. Stage 5 rules the
 * pair on BOTH columns.
 *
 * ⚠ STRICTLY READ-ONLY on prod (`research-probes.md` §The instrument is a claim too — the dev DB has no cron, so its recency is
 * all-stale by construction and a fire-rate measured there is vacuous). The only store call is
 * `getSeries`; there is no write, upsert or delete anywhere in this file.
 *
 * ⚠ NOT IN SCOPE, by ruling S4-R1: forward XLK return under the new RED/AMBER against a
 * label-rotation placebo. That arm is DEFERRED to its own rung and must run through the existing
 * harness `scripts/backtest/event-study.ts` (`runEventStudy`), pre-registered at its default
 * `HORIZONS_TD = [20, 60]` and F5-only (`scripts/backtest/data/rsp.csv` does not exist, so SPY/RSP
 * cannot be rebuilt from committed fixtures). Do NOT grow it into this probe — that would ship a
 * second instrument answering the same question under weaker rules, with no permutation p.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import type { ReadStore } from "../src/store.js";
import { ALL_INDICATORS } from "../src/registry.js";
import type { Indicator, Observation, State } from "../src/domain-types.js";
import { breadthReadingSeries, breadthConfig } from "../src/scorers-price.js";
import { breadthDistSeries, breadthCutSeries } from "../src/scorers-price.js";
import { BREADTH_CONFIG_OF } from "../src/family-descriptor-rows.js";
import { HIGH_WINDOW } from "../src/family-descriptor-rows.js";

import { envArgStrict } from "./lib/cli.js";

/** The two ids sharing the ONE generic `breadthReadingSeries`. Since 2026-08-30 they resolve
 *  DIFFERENT configs (F5 rolling-63, SPCONC rolling-126), so this report prints each id's own. */
const IDS = ["F5", "SPCONC"] as const;
const FETCH_LIMIT = 20_000;
/**
 * The quantile of the `|Δdist|` distribution at or above which a RED day is called a JUMP rather than
 * a TREND day. Reporting-only — it classifies rows in this table and can never reach a live cut, so an
 * in-sample edge is admissible here (the `ebpCalmTerciles` precedent).
 */
const JUMP_Q = 0.9;

interface Row {
  id: string;
  /** Days with a finite cut, i.e. actually ranked by the rolling percentile. */
  rankedDays: number;
  amberDays: number;
  redDays: number;
  amberPct: number;
  redPct: number;
  /** Latest finite cut values, in ratio-distance units (the units the user reads off the detail viz). */
  latestAmberCut: number;
  latestRedCut: number;
  latestDist: number;
  latestState: State;
  /** RED episodes = contiguous runs of confirmed RED in the series' own index. */
  redEpisodes: number;
  redRunMean: number;
  redRunMax: number;
  redJumpDays: number;
  redTrendDays: number;
  jumpEdge: number;
  firstDate: string;
  lastDate: string;
}

const envArg = envArgStrict("prod");

let store: ReadStore;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(`ABORT: no ${envArg} store reachable — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/**
 * Contiguous runs of `want` in the array's own index (NOT calendar) — the `bucketEpisodes` semantics
 * from `scripts/backtest/event-study.ts`, narrowed to a State.
 */
function runs(states: readonly State[], want: State): number[] {
  const out: number[] = [];
  let cur = 0;
  for (const s of states) {
    if (s === want) cur++;
    else if (cur > 0) {
      out.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) out.push(cur);
  return out;
}

/** The p-quantile of a finite sample by the same linear-interpolation rule `breadthCutSeries` uses. */
function quantile(sample: readonly number[], p: number): number {
  const xs = [...sample].sort((a, b) => a - b);
  if (xs.length === 0) return NaN;
  const pos = p * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo]!;
  return xs[lo]! + (pos - lo) * (xs[hi]! - xs[lo]!);
}

async function measure(indicator: Indicator): Promise<Row | string> {
  const points = await store.getSeries(indicator.id, FETCH_LIMIT);
  if (points.length === 0) return `the ${envArg} store returned zero ${indicator.id} closes`;

  // The stored `readings.value` for these two ids IS the ratio (QQQ/QQQE, SPY/RSP). Feed it as the
  // numerator leg against a unit denominator so the SHIPPED scorer's own ratio expression reproduces
  // it exactly — see the docblock's S4-R3 note. Ascending by date is what `alignByDate` expects.
  const asc = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const num: Observation[] = asc.map((p) => ({ date: p.date, value: p.value }));
  const den: Observation[] = asc.map((p) => ({ date: p.date, value: 1 }));

  // Per-id config, never the module defaults — F5 and SPCONC no longer share a triple (2026-08-30).
  const cfg = breadthConfig(indicator.id);
  // The scorer emits ONLY ranked days (finite cuts): the first lands at index `highWindow − 1 + minObs`.
  const readings = breadthReadingSeries(indicator, num, den);
  if (readings.length === 0) {
    return `${indicator.id} has ${asc.length} stored closes — below the scorer's ${cfg.highWindow + cfg.minObs}-close ranked floor (highWindow + minObs), nothing scored`;
  }

  // The same two arrays the scorer classified on, over the same ratio. Recomputed from `num` (not
  // re-derived by a local formula) so the cut VALUES this table prints are the scorer's own.
  const ratio = num.map((o) => o.value);
  const dist = breadthDistSeries(ratio, cfg.highWindow);
  const amberCut = breadthCutSeries(dist, cfg.amberP, cfg.cutWindow, cfg.minObs);
  const redCut = breadthCutSeries(dist, cfg.redP, cfg.cutWindow, cfg.minObs);

  // Each reading maps to its `dist`/cut index BY DATE (the scorer's own pattern) — never by a positional
  // offset, which drifts whenever the scorer changes which days it emits. `asc` IS the aligned series.
  const at = new Map(asc.map((p, i) => [p.date, i]));
  const idx = readings.map((r) => at.get(r.date)!);

  const states = readings.map((r) => r.state);
  const amberDays = states.filter((s) => s === "AMBER").length;
  const redDays = states.filter((s) => s === "RED").length;

  // Regime split, over the ranked (= emitted) window only.
  const deltas: number[] = [];
  for (const i of idx) {
    const d = dist[i]! - dist[i - 1]!;
    if (Number.isFinite(d)) deltas.push(Math.abs(d));
  }
  const jumpEdge = quantile(deltas, JUMP_Q);
  let redJumpDays = 0;
  for (let k = 0; k < readings.length; k++) {
    if (states[k] !== "RED") continue;
    const i = idx[k]!;
    const d = dist[i]! - dist[i - 1]!;
    if (Number.isFinite(d) && d >= jumpEdge) redJumpDays++;
  }
  const redRuns = runs(states, "RED");
  const last = readings.length - 1;
  const lastI = idx[last]!;

  return {
    id: indicator.id,
    rankedDays: readings.length,
    amberDays,
    redDays,
    amberPct: (100 * amberDays) / readings.length,
    redPct: (100 * redDays) / readings.length,
    latestAmberCut: amberCut[lastI]!,
    latestRedCut: redCut[lastI]!,
    latestDist: dist[lastI]!,
    latestState: readings[last]!.state,
    redEpisodes: redRuns.length,
    redRunMean: redRuns.length === 0 ? 0 : redRuns.reduce((a, b) => a + b, 0) / redRuns.length,
    redRunMax: redRuns.length === 0 ? 0 : Math.max(...redRuns),
    redJumpDays,
    redTrendDays: redDays - redJumpDays,
    jumpEdge,
    firstDate: readings[0]!.date,
    lastDate: readings[last]!.date,
  };
}

const pc = (x: number) => `${x.toFixed(2)}%`;
const sig = (x: number) => (Number.isFinite(x) ? x.toExponential(3) : "n/a");

const rows: Row[] = [];
const aborts: string[] = [];
for (const id of IDS) {
  const indicator = ALL_INDICATORS.find((i) => i.id === id);
  if (indicator === undefined) {
    aborts.push(`${id} is absent from ALL_INDICATORS — this probe measures its band`);
    continue;
  }
  const out = await measure(indicator);
  if (typeof out === "string") aborts.push(out);
  else rows.push(out);
}

console.log(`\nF5/SPCONC rolling-percentile band — duty cycle on the ${envArg} store (READ-ONLY)`);
console.log(
  Object.entries(BREADTH_CONFIG_OF)
    .filter(([id]) => id === "F5" || id === "SPCONC")
    .map(([id, c]) => `${id}: AMBER p${(100 * c.amberP).toFixed(1)} / RED p${(100 * c.redP).toFixed(1)} over a rolling ${c.cutWindow}`)
    .join("   ") + `  (src/family-descriptor-rows.ts — a retune moves this report with no edit here)`,
);
console.log(`Ranked = days with a finite rolling-percentile cut (needs ${HIGH_WINDOW} + that id's cut window).`);

console.log(`\n① DUTY CYCLE (confirmed states, the ones that count)`);
console.log(`    id       ranked   AMBER days     RED days   window`);
for (const r of rows) {
  console.log(
    `    ${r.id.padEnd(8)} ${String(r.rankedDays).padStart(6)}   ` +
      `${String(r.amberDays).padStart(5)} ${pc(r.amberPct).padStart(7)}   ` +
      `${String(r.redDays).padStart(5)} ${pc(r.redPct).padStart(7)}   ` +
      `${r.firstDate} → ${r.lastDate}`,
  );
}

console.log(`\n② THE CUT IN RATIO-DISTANCE UNITS (latest ranked day — what the cut probabilities actually mean)`);
console.log(`    id       amberCut      redCut        dist today   state`);
for (const r of rows) {
  console.log(
    `    ${r.id.padEnd(8)} ${sig(r.latestAmberCut).padStart(11)} ${sig(r.latestRedCut).padStart(11)}   ` +
      `${sig(r.latestDist).padStart(11)}   ${r.latestState}`,
  );
}

console.log(`\n③ REGIME SPLIT — does RED mark a sustained regime, or a breakout ACCELERATION?`);
console.log(`    JUMP day = Δdist ≥ p${(100 * JUMP_Q).toFixed(0)} of |Δdist| over the ranked window; TREND day = the rest.`);
console.log(`    id       RED days   episodes  run mean  run max   JUMP   TREND   jump edge`);
for (const r of rows) {
  console.log(
    `    ${r.id.padEnd(8)} ${String(r.redDays).padStart(8)}   ${String(r.redEpisodes).padStart(8)}  ` +
      `${r.redRunMean.toFixed(2).padStart(8)}  ${String(r.redRunMax).padStart(7)}   ` +
      `${String(r.redJumpDays).padStart(4)}   ${String(r.redTrendDays).padStart(5)}   ${sig(r.jumpEdge)}`,
  );
}
console.log(
  `    Read: short mean runs ⇒ the state does not persist. A JUMP-dominated RED column would make it a\n` +
    `    pure acceleration trigger; a TREND-dominated one means most RED days are ordinary drift across a\n` +
    `    cut that has crept down, which is a DIFFERENT thing to rule a cut pair on. Report both, rule on both.`,
);

console.log(`\nNOT MEASURED HERE (ruling S4-R1): forward XLK return vs a label-rotation placebo — deferred`);
console.log(`to its own rung, through scripts/backtest/event-study.ts at HORIZONS_TD [20, 60], F5 only.`);

// ---------- falsifier: this probe must be able to RED, and to ESTABLISH when it is green ----------
const failures: string[] = [...aborts];
for (const r of rows) {
  if (r.rankedDays <= 0) failures.push(`${r.id}: rankedDays=${r.rankedDays} — no day was ranked`);
  for (const [name, v] of [
    ["amberPct", r.amberPct],
    ["redPct", r.redPct],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 100) failures.push(`${r.id}: ${name}=${v} is not a finite percentage in [0,100]`);
  }
  for (const [name, v] of [
    ["latestAmberCut", r.latestAmberCut],
    ["latestRedCut", r.latestRedCut],
  ] as const) {
    if (!Number.isFinite(v)) failures.push(`${r.id}: ${name}=${v} is not finite — the percentile never ranked`);
  }
  // The band's own ordering: the RED cut can never sit below the AMBER cut of the same day.
  if (Number.isFinite(r.latestRedCut) && Number.isFinite(r.latestAmberCut) && r.latestRedCut < r.latestAmberCut) {
    failures.push(`${r.id}: redCut ${r.latestRedCut} < amberCut ${r.latestAmberCut} — the band is inverted`);
  }
}
if (rows.length !== IDS.length) failures.push(`measured ${rows.length} of ${IDS.length} ids`);

if (failures.length > 0) {
  console.log(`\n❌ FAIL (${failures.length})`);
  for (const f of failures) console.log(`    · ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ PASS — ${rows.length} ids ranked, every duty-cycle and cut cell finite and ordered.`);
}
