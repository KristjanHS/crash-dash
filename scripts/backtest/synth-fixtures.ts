/**
 * Seeded synthetic backtest fixtures — real market data is not distributed with this repository.
 *
 * Regenerates every committed fixture listed in `SYNTH_FIXTURES` from one fixed seed,
 * deterministically: re-running yields byte-identical files.
 *
 *   npm run synth:fixtures            # rewrite every SYNTH_FIXTURES file (seed 1)
 *   npm run synth:fixtures -- --seed 2   # perturb arm (falsifier demo; do not commit)
 *
 * Model (weekday calendar, no holidays):
 *   - ONE shared market factor drawn from a two-regime Markov chain — calm (positive drift, low vol)
 *     and stress (negative drift, high vol, short-lived). Every equity fixture loads on it with its
 *     own `beta`, so cross-fixture correlation rises in stress the way a real sell-off does — the
 *     dispersion / breadth / event-study mechanics have episodes to find.
 *   - Per-fixture idiosyncratic noise from its own seeded stream (`seriesRand(seed, name)`).
 *   - FX (`cny`) has beta 0 and a slow mean reversion toward its anchor level.
 *   - Risk LEVELS (`LEVEL_SPECS`: credit spread, vol indices, financial-conditions risk) mean-revert
 *     toward a calm level and spike toward a per-episode stress target while the shared factor sits in
 *     its stress regime, plus a negative loading on the factor's daily return — counter-cyclical to
 *     the equity fixtures, so the level-cut probes find their episodes on the same dates.
 *   - The factor's core span (the union of the equity specs) is drawn first and never changes; dates
 *     before / after it come from separate seeded chains, so a longer level span leaves the equity
 *     fixtures byte-identical.
 * Every CSV opens with the `SYNTH_MARKER` comment line, then the usual `date,value` header. Every
 * reader of `scripts/backtest/data/*.csv` drops line 1 and skips non-numeric rows, so the marker
 * and the (now second) header line are both skipped. JSON fixtures carry the marker as a top-level
 * `"synthetic"` key instead.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoDay } from "../../src/dates.js";
import { lcg, seriesRand } from "../lib/seeded-lcg.js";

export const SYNTH_SEED = 1;
export const SYNTH_DATA_DIR = "scripts/backtest/data";
/** Line 1 of every generated fixture. No comma, so no `date,value` reader can parse it as a row. */
export const SYNTH_MARKER =
  "# synthetic fixture (seeded) from scripts/backtest/synth-fixtures.ts — real market data is not distributed with this repository";
const GENERATED_BY = "npm run synth:fixtures";

interface FixtureSpec {
  /** File basename under SYNTH_DATA_DIR, without `.csv`. */
  name: string;
  /** First and last calendar day of the span; weekdays only are emitted. */
  start: string;
  end: string;
  /** Level on `start`. */
  base: number;
  /** Loading on the shared market factor. */
  beta: number;
  /** Annualized idiosyncratic vol. */
  idioVol: number;
  /** Annualized extra drift on top of beta × market. */
  alpha: number;
  /** Daily pull of log level back toward log(base) — FX only. */
  meanRevert?: number;
  /** Decimal places written. */
  digits: number;
}

/** Spans and levels track the instruments' public listing dates; values are pure model output. */
const FIXTURE_SPECS: readonly FixtureSpec[] = [
  { name: "spy", start: "1993-01-29", end: "2026-06-26", base: 24, beta: 1.0, idioVol: 0.02, alpha: 0, digits: 4 },
  { name: "qqq", start: "1999-03-10", end: "2026-08-07", base: 51, beta: 1.25, idioVol: 0.08, alpha: 0.02, digits: 4 },
  { name: "qqqe", start: "2012-03-21", end: "2026-08-07", base: 20, beta: 1.15, idioVol: 0.06, alpha: 0, digits: 4 },
  { name: "smh_adj", start: "2000-06-05", end: "2026-08-07", base: 42, beta: 1.5, idioVol: 0.16, alpha: 0.03, digits: 4 },
  { name: "eem", start: "2003-04-14", end: "2026-08-07", base: 7.2, beta: 1.05, idioVol: 0.12, alpha: -0.01, digits: 4 },
  { name: "exsh", start: "2008-01-02", end: "2026-08-07", base: 15, beta: 1.2, idioVol: 0.14, alpha: -0.03, digits: 4 },
  { name: "fez", start: "2002-10-21", end: "2026-08-07", base: 12, beta: 1.05, idioVol: 0.1, alpha: -0.02, digits: 4 },
  { name: "value", start: "2014-09-11", end: "2026-08-03", base: 25.5, beta: 0.9, idioVol: 0.08, alpha: 0, digits: 4 },
  { name: "vea", start: "2007-07-26", end: "2026-06-26", base: 27, beta: 0.95, idioVol: 0.09, alpha: -0.02, digits: 4 },
  { name: "xlk", start: "1998-12-22", end: "2026-07-23", base: 12, beta: 1.3, idioVol: 0.08, alpha: 0.02, digits: 4 },
  { name: "xlp", start: "1998-12-22", end: "2026-08-07", base: 14, beta: 0.55, idioVol: 0.08, alpha: 0.01, digits: 4 },
  { name: "xlv", start: "1998-12-22", end: "2026-08-07", base: 16.7, beta: 0.65, idioVol: 0.1, alpha: 0.02, digits: 4 },
  { name: "cny", start: "2001-06-25", end: "2026-08-11", base: 7.0, beta: 0, idioVol: 0.03, alpha: 0, meanRevert: 0.002, digits: 4 },
];

/** A mean-reverting risk level that spikes in the factor's stress regime. */
interface LevelSpec {
  name: string;
  start: string;
  end: string;
  /** Level the series reverts to in the calm regime (and its value on `start`). */
  calm: number;
  /** Stress-regime target at intensity 1; each episode draws its intensity in [0.5, 1.5). */
  peak: number;
  /** Hard bounds after every step. */
  floor: number;
  cap: number;
  /** Daily pull toward the regime's target: calm / stress. */
  revert: number;
  stressRevert: number;
  /** Daily noise sd (in log units when `log`). */
  vol: number;
  /** Loading on the factor's daily log return (negative = rises in a sell-off). */
  gamma: number;
  /** Model log(level) — positive series; linear otherwise (may go negative). */
  log: boolean;
  /** Optional idiosyncratic shock: daily probability and size (× a [0.5, 1.5) draw) of a one-day jump up. */
  jumpProb?: number;
  jumpSize?: number;
  /** Emit Fridays only (a weekly-published series). */
  weekly?: boolean;
  digits: number;
}

/** Ranges track the public indices' typical calm / crisis levels; values are pure model output. */
const LEVEL_SPECS: readonly LevelSpec[] = [
  { name: "hyoas", start: "2008-03-28", end: "2026-07-17", calm: 4.2, peak: 11, floor: 2.5, cap: 20, revert: 0.005, stressRevert: 0.06, vol: 0.015, gamma: -1.2, log: true, digits: 2 },
  { name: "move", start: "2002-11-12", end: "2026-07-17", calm: 85, peak: 140, floor: 45, cap: 200, revert: 0.02, stressRevert: 0.08, vol: 0.03, gamma: -1.5, log: true, jumpProb: 1 / 150, jumpSize: 0.35, digits: 2 },
  { name: "vix", start: "1990-01-02", end: "2026-08-06", calm: 16, peak: 38, floor: 9, cap: 80, revert: 0.03, stressRevert: 0.12, vol: 0.05, gamma: -3, log: true, jumpProb: 1 / 120, jumpSize: 0.6, digits: 2 },
  { name: "nfcirisk", start: "1971-01-08", end: "2026-07-31", calm: -0.4, peak: 1.5, floor: -1, cap: 3, revert: 0.01, stressRevert: 0.06, vol: 0.02, gamma: -3, log: false, weekly: true, digits: 3 },
];

/** The HY OAS live-feed slice over the vintage overlap (`f1-percentile-cuts.ts` `OVERLAP_FIXTURE_URL`). */
const OVERLAP = { file: `${SYNTH_DATA_DIR}/hyoas_live_overlap.json`, series: "BAMLH0A0HYM2", from: "2023-07-21", to: "2025-04-10", captured: "2026-07-20" } as const;

/**
 * The semis drawdown-watch harness fixture: per-id series over the window; its `events` are kept verbatim.
 * Its ids load on their OWN regime chain (`WATCH_SWITCH`: shorter, more frequent stress spells than the
 * shared factor), so the two-year window holds several correction episodes — and none so long and deep
 * that the watch's per-session latch walk-back dominates the harness test's runtime.
 */
const WATCH = { file: "scripts/probe-semis-tranches.watch.json", from: "2024-10-01", to: "2026-10-30" } as const;
type WatchSeries = { id: string; start?: string; end?: string } & ({ kind: "price"; spec: Omit<FixtureSpec, "name" | "start" | "end"> } | { kind: "level"; spec: Omit<LevelSpec, "name" | "start" | "end"> });
const WATCH_SERIES: readonly WatchSeries[] = [
  { id: "LEGP_SEMIS", kind: "price", spec: { base: 6.7, beta: 1.5, idioVol: 0.2, alpha: 0.2, digits: 4 } },
  { id: "F1", end: "2026-10-29", kind: "level", spec: { calm: 3.2, peak: 7, floor: 2.5, cap: 12, revert: 0.01, stressRevert: 0.06, vol: 0.015, gamma: -1.2, log: true, digits: 2 } },
  { id: "HCX", kind: "level", spec: { calm: -0.08, peak: -0.16, floor: -0.25, cap: 0.05, revert: 0.02, stressRevert: 0.06, vol: 0.004, gamma: 0.5, log: false, digits: 6 } },
  { id: "F8", kind: "price", spec: { base: 100, beta: 2, idioVol: 0.4, alpha: 0.8, digits: 4 } },
  { id: "MU_RS", kind: "price", spec: { base: 0.42, beta: 0.6, idioVol: 0.35, alpha: 0.4, digits: 6 } },
  { id: "VXSMH", start: "2025-10-14", kind: "level", spec: { calm: 42, peak: 65, floor: 25, cap: 90, revert: 0.03, stressRevert: 0.12, vol: 0.04, gamma: -2, log: true, digits: 2 } },
  { id: "RS_SMH", kind: "price", spec: { base: 0.43, beta: 0.4, idioVol: 0.2, alpha: 0.15, digits: 6 } },
  { id: "R4", kind: "level", spec: { calm: 2.0, peak: 1.6, floor: 1, cap: 3.5, revert: 0.01, stressRevert: 0.04, vol: 0.02, gamma: 0, log: false, digits: 2 } },
  { id: "BBB", end: "2026-10-29", kind: "level", spec: { calm: 1.15, peak: 1.9, floor: 0.8, cap: 3, revert: 0.01, stressRevert: 0.06, vol: 0.012, gamma: -1, log: true, digits: 2 } },
];

/** Repo-relative path of every generated file — the generator's own output list. */
export const SYNTH_FIXTURES: readonly string[] = [
  ...FIXTURE_SPECS.map((s) => `${SYNTH_DATA_DIR}/${s.name}.csv`),
  ...LEVEL_SPECS.map((s) => `${SYNTH_DATA_DIR}/${s.name}.csv`),
  OVERLAP.file,
  WATCH.file,
];

const DAYS_PER_YEAR = 252;
/** Market-factor regimes: [annual drift, annual vol]; daily switch probabilities. */
const CALM = { drift: 0.11, vol: 0.14 };
const STRESS = { drift: -0.9, vol: 0.42 };
const MARKET_SWITCH = { enter: 1 / 700, exit: 1 / 40 };
const WATCH_SWITCH = { enter: 1 / 150, exit: 1 / 12 };

/** Weekday ISO dates from `start` through `end`, inclusive, oldest→newest. */
function weekdays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`).getTime();
  while (d.getTime() <= stop) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(isoDay(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const isFriday = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 5;

/** Standard normal via Box–Muller off a uniform stream. */
function normal(rand: () => number): () => number {
  return () => {
    const u = 1 - rand(); // (0,1] — log(0) never happens
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

/** One market-factor day: daily log return + whether the chain sits in its stress regime. */
export interface MarketDay {
  r: number;
  stress: boolean;
}

/** Run the regime chain over `dates`, appending to `out`. */
function runChain(dates: readonly string[], rand: () => number, z: () => number, p: { enter: number; exit: number }, out: Map<string, MarketDay>): void {
  let stress = false;
  for (const date of dates) {
    stress = stress ? rand() >= p.exit : rand() < p.enter;
    const { drift, vol } = stress ? STRESS : CALM;
    out.set(date, { r: drift / DAYS_PER_YEAR + (vol / Math.sqrt(DAYS_PER_YEAR)) * z(), stress });
  }
}

/**
 * Shared market factor keyed by date. The CORE span (union of the equity specs) is drawn from the
 * original streams in the original order, so the equity fixtures stay byte-identical; dates before it
 * (the longer level spans only) come from their own seeded streams.
 */
function marketFactor(seed: number): Map<string, MarketDay> {
  const first = FIXTURE_SPECS.reduce((a, s) => (s.start < a ? s.start : a), FIXTURE_SPECS[0]!.start);
  const last = FIXTURE_SPECS.reduce((a, s) => (s.end > a ? s.end : a), FIXTURE_SPECS[0]!.end);
  const late = LEVEL_SPECS.filter((s) => s.end > last).map((s) => s.name);
  if (late.length) throw new Error(`[synth-fixtures] ${late.join(", ")} end after the market factor's ${last}`);
  const extFirst = LEVEL_SPECS.reduce((a, s) => (s.start < a ? s.start : a), first);
  const out = new Map<string, MarketDay>();
  runChain(weekdays(extFirst, first).filter((d) => d < first), seriesRand(seed, "market-pre"), normal(seriesRand(seed, "market-pre-z")), MARKET_SWITCH, out);
  runChain(weekdays(first, last), seriesRand(seed, "market"), normal(lcg((seed * 40503 + 7) >>> 0)), MARKET_SWITCH, out);
  return out;
}

/** The watch fixture's own factor over its window (`WATCH_SWITCH`). */
function watchFactor(seed: number): Map<string, MarketDay> {
  const out = new Map<string, MarketDay>();
  runChain(weekdays(WATCH.from, WATCH.to), seriesRand(seed, "watch-market"), normal(seriesRand(seed, "watch-market-z")), WATCH_SWITCH, out);
  return out;
}

/** One equity/FX path as [date, level] rows, fully determined by `seed` and the stream `name`. */
function pricePath(name: string, start: string, end: string, spec: Omit<FixtureSpec, "name" | "start" | "end">, market: Map<string, MarketDay>, seed: number): [string, number][] {
  const z = normal(seriesRand(seed, name));
  const anchor = Math.log(spec.base);
  let logLevel = anchor;
  return weekdays(start, end).map((date, i): [string, number] => {
    if (i > 0) {
      const m = market.get(date)?.r ?? 0;
      const pull = spec.meanRevert ? spec.meanRevert * (anchor - logLevel) : 0;
      logLevel += spec.alpha / DAYS_PER_YEAR + spec.beta * m + (spec.idioVol / Math.sqrt(DAYS_PER_YEAR)) * z() + pull;
    }
    return [date, Math.exp(logLevel)];
  });
}

/** One risk-level path as [date, level] rows (Fridays only when `weekly`). */
function levelPath(name: string, start: string, end: string, spec: Omit<LevelSpec, "name" | "start" | "end">, market: Map<string, MarketDay>, seed: number): [string, number][] {
  const rand = seriesRand(seed, name);
  const z = normal(seriesRand(seed, `${name}-z`));
  const tf = (v: number): number => (spec.log ? Math.log(v) : v);
  const [calm, peak, lo, hi] = [tf(spec.calm), tf(spec.peak), tf(spec.floor), tf(spec.cap)];
  let x = calm;
  let wasStress = false;
  let intensity = 1;
  const out: [string, number][] = [];
  weekdays(start, end).forEach((date, i) => {
    const day = market.get(date) ?? { r: 0, stress: false };
    if (i > 0) {
      if (day.stress && !wasStress) intensity = 0.5 + rand();
      const target = day.stress ? calm + (peak - calm) * intensity : calm;
      x += (day.stress ? spec.stressRevert : spec.revert) * (target - x) + spec.vol * z() + spec.gamma * day.r;
      if (spec.jumpProb && rand() < spec.jumpProb) x += (spec.jumpSize ?? 0) * (0.5 + rand());
      x = Math.min(hi, Math.max(lo, x));
    }
    wasStress = day.stress;
    if (!spec.weekly || isFriday(date)) out.push([date, spec.log ? Math.exp(x) : x]);
  });
  return out;
}

const round = (v: number, digits: number): number => Number(v.toFixed(digits));

function renderCsv(rows: readonly [string, number][], digits: number): string {
  return [SYNTH_MARKER, "date,value", ...rows.map(([d, v]) => `${d},${v.toFixed(digits)}`)].join("\n") + "\n";
}

/** One fixture's CSV body (marker + header + rows), fully determined by `seed`. */
export function renderFixture(spec: FixtureSpec, market: Map<string, MarketDay>, seed: number): string {
  return renderCsv(pricePath(spec.name, spec.start, spec.end, spec, market, seed), spec.digits);
}

/** The HY OAS overlap JSON: the synthetic `hyoas` path cut to the overlap window. */
function renderOverlap(hyoas: readonly [string, number][], digits: number): string {
  const observations = hyoas.filter(([d]) => d >= OVERLAP.from && d <= OVERLAP.to).map(([date, v]) => ({ date, value: round(v, digits) }));
  return `${JSON.stringify({ synthetic: SYNTH_MARKER, series: OVERLAP.series, captured: OVERLAP.captured, source: GENERATED_BY, n: observations.length, observations }, null, 2)}\n`;
}

/** The watch fixture: synthetic `series`, `events` carried over verbatim from the file being replaced. */
function renderWatch(seed: number, events: unknown): string {
  const market = watchFactor(seed);
  const series = Object.fromEntries(
    WATCH_SERIES.map((w) => {
      const [start, end, stream] = [w.start ?? WATCH.from, w.end ?? WATCH.to, `watch:${w.id}`];
      const rows = w.kind === "price" ? pricePath(stream, start, end, w.spec, market, seed) : levelPath(stream, start, end, w.spec, market, seed);
      return [w.id, rows.map(([d, v]) => [d, round(v, w.spec.digits)])];
    }),
  );
  const ids = WATCH_SERIES.map((w) => w.id);
  const head = { synthetic: SYNTH_MARKER, generatedBy: GENERATED_BY, from: WATCH.from, to: WATCH.to, ids };
  return [
    `{${Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")},`,
    `"series":{`,
    ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(series[id])}`).join(",\n"),
    `},`,
    `"events":${JSON.stringify(events)}}`,
  ].join("\n") + "\n";
}

/** The watch fixture's `events` as committed in `repoRoot` — carried over verbatim, never generated. */
export function readWatchEvents(repoRoot: string): unknown[] {
  return parseWatchEvents(readFileSync(join(repoRoot, WATCH.file), "utf8"));
}

/** `events` out of a watch-fixture body; throws when it has none to carry over. */
export function parseWatchEvents(body: string): unknown[] {
  const { events } = JSON.parse(body) as { events: unknown };
  if (!Array.isArray(events)) throw new Error(`[synth-fixtures] ${WATCH.file} has no events array to carry over`);
  return events;
}

/** Every `SYNTH_FIXTURES` body (repo-relative path → bytes), fully determined by `seed` + the watch `events`. No IO. */
export function renderSynthFixtures(seed: number, watchEvents: readonly unknown[]): Map<string, string> {
  const market = marketFactor(seed);
  const out = new Map<string, string>();
  for (const spec of FIXTURE_SPECS) out.set(`${SYNTH_DATA_DIR}/${spec.name}.csv`, renderFixture(spec, market, seed));
  for (const spec of LEVEL_SPECS) {
    const rows = levelPath(spec.name, spec.start, spec.end, spec, market, seed);
    out.set(`${SYNTH_DATA_DIR}/${spec.name}.csv`, renderCsv(rows, spec.digits));
    if (spec.name === "hyoas") out.set(OVERLAP.file, renderOverlap(rows, spec.digits));
  }
  out.set(WATCH.file, renderWatch(seed, watchEvents));
  return out;
}

export function writeSynthFixtures(seed: number, repoRoot: string, watchEvents: readonly unknown[] = readWatchEvents(repoRoot)): string[] {
  const rendered = renderSynthFixtures(seed, watchEvents);
  for (const [rel, body] of rendered) writeFileSync(join(repoRoot, rel), body);
  return [...rendered.keys()];
}

const isMain = process.argv[1]?.endsWith("synth-fixtures.ts") ?? false;
if (isMain) {
  const args = process.argv.slice(2);
  const seedIdx = args.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number(args[seedIdx + 1]) : SYNTH_SEED;
  if (!Number.isInteger(seed)) throw new Error("[synth-fixtures] bad --seed");
  const written = writeSynthFixtures(seed, process.cwd());
  console.log(`[synth-fixtures] wrote ${written.length} fixtures (seed ${seed})`);
}
