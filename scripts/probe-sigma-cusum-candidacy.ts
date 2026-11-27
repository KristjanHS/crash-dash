/**
 * σ-z + CUSUM CANDIDACY PROBE — "would a rolling-σ velocity leg (and a CUSUM persistence leg on
 * top of it) contribute anything on this indicator, and is its σ degenerate over any era?"
 *
 * Generalized 2026-08-09 from the five throwaway probes the F11 measurement ran, which in turn
 * mirrored the F9 arc's `tmp-f9-cusum-sweep.ts`.
 * The question is generic and recurs per id, so it is an instrument, not a throwaway.
 *
 *   npx tsx scripts/probe-sigma-cusum-candidacy.ts --id=F11
 *   npx tsx scripts/probe-sigma-cusum-candidacy.ts --id=F9 --k=0.5 --h=2,3,4,5,6,8
 *
 * READ-ONLY and STORE-FREE: the only IO is the id's own keyless feed (`fetchIndicatorObservations`). It touches no
 * store, writes no file, and prints AGGREGATE COUNTS ONLY — no per-day log (the [USER] budget cap
 * that `probe-low-branch-tie.ts` carries applies here too). `--dates` prints at most `MAX_DATES`
 * ISO dates so a non-zero count can be chased by a human; it is capped, not a log.
 *
 * ═══ INVARIANTS THAT BIND A RE-RUN ═══════════════════════════════════════════════════════════
 *
 * ⚠ **1. THE σ CONFIG IS BORROWED FOR ANY ID THAT LACKS ONE, AND EVERY σ NUMBER IS CONDITIONAL
 * ON THAT BORROW.** Only an id carrying `thresholds.velocitySigma` has a σ window of
 * its own. For every other id this probe borrows F9's `F9_SIGMA_WINDOW` / `F9_SIGMA_MIN_OBS` —
 * a CHOICE, never a silent default: the borrow is printed in the header as `σ config: BORROWED`
 * and `--sigma-window=` / `--sigma-min-obs=` override it. A z, a Jaccard or an h-sweep row from a
 * borrowed config is evidence about *that* config, not about the id. Do not quote one without the
 * borrow attached.
 *
 * ⚠ **2. THE PERCENTILE BASELINE RECONCILES TO THE *STORED* HISTORY, NOT THE FRED FEED.** The live
 * cut production scores against is `computeSynthCutsDetailed` → `absDelta(history, w)` →
 * `expandingPercentile(...).at(-1)`, and its `history` is the STORE (`readings`, which begins
 * 2011-08), not the deep feed this probe fetches. Measured on F11 2026-08-09: the same percentile
 * is 0.1585/0.2948 over the full 11,377-obs feed but 0.2189/0.3289 from 2011-08 — and prod serves
 * 0.2190/0.3294. ⇒ **A `fullHistory` σ arm is judged against a base the live cut never sees.**
 * Hence `--stored-from` (default `STORED_ERA_FROM`) and the `stored` era row: the stored-era arm is
 * the decision arm; the full-history arm is context. The header prints both cuts side by side so a
 * divergence announces itself instead of being assumed away.
 *
 * ⚠ **3. THE CUT IS MEASURED TWO-SIDED BUT FIRES ONE-SIDED.** `computeSynthCutsDetailed` takes the
 * percentile over `|Δw|`, while `evaluateLegs` (`domain-legs.ts`) compares it as
 * `delta20 >= bound` — the SIGNED Δw, via the `measured` ⇒ `velEvt` branch. This probe reproduces
 * that asymmetry exactly (`sgnDelta(i) >= cut`). A fire count computed on `|Δw| >= cut` would be
 * roughly double and would be wrong; do not "fix" it to match the cut's own two-sidedness.
 *
 * ⚠ **4. THE z SERIES IS OFFSET BY THE GLOBAL `VELOCITY_WINDOW`, NOT BY `w`.**
 * `velocitySigmaZSeries` walks `for (let i = VELOCITY_WINDOW; i < n; i++)`, so its output index `j`
 * maps to observation index `j + VELOCITY_WINDOW` regardless of the id's own `velocityWindow`.
 * Every alignment here goes through `zAt`/`sAt`; do not index the arrays directly.
 *
 * ⚠ **5. THE RECURRENCE IS THE PRODUCTION ONE (`velocityCusumSeries`, reset-on-alarm since
 * 2026-08-09) — BUT BLOCK 4'S BOUND WIRING IS NOT.** Block 4 sweeps a single `h` used as both the
 * fire test and the reset point; production passes `cusumRedBound` as the reset and tests AMBER
 * separately at `cusumH` (`legBounds`, `domain-legs.ts`). ⇒ **Block 4 cannot produce an amber share
 * at any `k`**, which is how rounds 4 and 5 shipped unmeasured. **Block 6 is the two-bound arm** and
 * is the one to read for a production-shaped figure; block 4 is kept unchanged as the provenance
 * baseline those rounds were ruled off. Do not quote a block-4 row as an amber number.
 * The no-reset arm is computed inline as a CONTROL — it is the ratchet the reset exists to kill, and
 * printing it is what makes the reset's effect falsifiable rather than asserted. It is not a
 * candidate shape; do not read its row as an option.
 *
 * ⚠ **6. REGISTERED-`series` IDS ONLY.** The feed is `fetchIndicatorObservations(indicator,
 * {fullHistory:true})`, which dispatches on `FEED_OF` (registry.ts). A derived id has no `series`
 * and is REJECTED loudly rather than silently probed against a wrong feed.
 *
 * ⚠ **7. `--visibility` COPIES `genericSingle`'S FRAME MATH AND ITS IN-DOMAIN PREDICATE; THE TWO
 * MUST STAY IN SYNC.** The detail chart frames the y-domain from the PLOTTED SERIES ALONE
 * (invariant D0-a: a moving cut must never drag the frame), `[lo,hi] = extent(Δw) ± 0.08·range`,
 * and then drops any per-point cut failing `v >= lo && v <= hi` — `public/detail-chart.js`
 * `genericSingle`, the `cuts` mapper. Both expressions are reproduced verbatim here. If that
 * renderer's pad or predicate changes, this block silently reports the OLD chart; re-read it
 * before quoting an in-frame count. ⇒ An in-frame count is a statement about ONE WINDOW, never
 * about the cut: the same multiple can be 0% visible over 365 days and 100% over 500.
 * ⚠ The window is the FEED's trailing N observations, which equals the served
 * `/api/series?limit=N` window only while the store and the feed end on the same date. The probe
 * PRINTS its window span so a mismatch with a real payload is visible, never assumed away.
 *
 * ⚠ **8. ERA BOUNDARIES ARE DERIVED, NOT HAND-LISTED.** The degeneracy exit is found by scanning
 * for the last date whose rolling σ sits below `DEGEN_FRACTION` of the MODERN median σ — so a
 * peg, a managed float, or any other variance collapse announces itself on an id nobody has looked
 * at yet. The absolute σ bars in the same table are reported alongside it, because a fraction-of-
 * modern bar and an absolute bar can disagree (on F11 they do: the peg exit clears the relative bar
 * in 2005, while the absolute σ ≥ 0.05 bar is set by the unrelated 2013-14 low-vol dip in 2014).
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { fetchIndicatorObservations } from "../src/indicator-feed.js";
import { velocitySigmaZSeries, velocityCusumSeries } from "../src/domain-fold.js";
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import { F9_SIGMA_WINDOW, F9_SIGMA_MIN_OBS, F9_CUSUM_K, F9_CUSUM_H, F9_CUSUM_H_RED } from "../src/registry-fred.js";
import { expandingPercentile } from "../src/percentile.js";
import { SYNTH_AMBER_PCTILE, SYNTH_RED_PCTILE } from "../src/synth-cuts.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

/**
 * Where the `readings` store's history begins — the base the LIVE percentile cut is really taken
 * over (invariant 2). Measured on prod 2026-08-08: F11 carries ~3,682 rows from 2011-08.
 * A per-id override is `--stored-from=`; this default is the store's own floor, not an id's.
 */
const STORED_ERA_FROM = "2011-08-02";
/** Fraction of the MODERN median σ below which a day's σ counts as degenerate (invariant 7). */
const DEGEN_FRACTION = 0.1;
/** How many trailing usable-z days define "modern" for that median. ~5 trading years. */
const MODERN_TAIL = 1260;
/** Absolute σ bars reported alongside the relative one, as decades of the modern median. */
const ABS_BAR_DECADES = [0.001, 0.01, 0.1, 0.3];
/**
 * Default `--visibility` window — mirrors `public/chart-primitives.js` `DETAIL_LIMIT`, the number
 * of points the detail panel actually fetches. Restated here because this script cannot import a
 * browser module; if that constant moves, this one is stale and the block reports the wrong frame.
 */
const DETAIL_LIMIT = 365;
/** Cap on the `--dates` escape hatch — a bounded chase list, never a per-day log. */
const MAX_DATES = 20;

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const nums = (name: string, fallback: number[]): number[] => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const out = raw.split(",").map(Number);
  if (out.some((v) => !Number.isFinite(v))) throw new Error(`--${name}: not a number list: ${raw}`);
  return out;
};
const wantDates = process.argv.includes("--dates");
const wantVisibility = process.argv.includes("--visibility");

// ── small stats helpers (no dependency on the app's own, deliberately: this must not move) ────
const pctOf = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
}
/** Contiguous run lengths of `true` — the episode structure both legs are judged on. */
function runLengths(fired: readonly boolean[]): number[] {
  const out: number[] = [];
  let cur = 0;
  for (const f of fired) {
    if (f) cur++;
    else if (cur) {
      out.push(cur);
      cur = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return { inter, uni, j: uni ? inter / uni : NaN };
}
const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`;

// ── resolve the indicator + its σ config ──────────────────────────────────────────────────────
const id = arg("id");
if (!id) {
  const candidates = ALL_INDICATORS.filter((i) => i.series && i.thresholds?.amberVelocity !== undefined);
  throw new Error(
    `--id=<indicator> is required. FRED-fed velocity-scored ids: ${candidates.map((i) => i.id).join(", ")}`,
  );
}
const indicator = ALL_INDICATORS.find((i) => i.id === id);
if (!indicator) throw new Error(`unknown indicator id: ${id}`);
if (!indicator.series) {
  // Invariant 6 — reject rather than probe a price/derived id against a feed it does not use.
  throw new Error(`${id} has no FRED \`series\` (price-fed or derived) — this probe reads FRED only.`);
}
const w = indicator.velocityWindow ?? VELOCITY_WINDOW;
const own = indicator.thresholds?.velocitySigma;
const sigmaCfg = {
  window: Number(arg("sigma-window") ?? own?.window ?? F9_SIGMA_WINDOW),
  minObs: Number(arg("sigma-min-obs") ?? own?.minObs ?? F9_SIGMA_MIN_OBS),
  // ⛔ Forward the blend arms too, or an "OWN" label measures a blended id RECTANGULARLY (ruling 4:
  // ONE implementation). No CLI override — the shipped estimator is the only thing under test here.
  ewmaHalfLife: own?.ewmaHalfLife,
  ewmaFloorFactor: own?.ewmaFloorFactor,
};
const sigmaProvenance = arg("sigma-window") ?? arg("sigma-min-obs")
  ? "CLI OVERRIDE"
  : own
    ? `OWN (${id}.thresholds.velocitySigma)`
    : `BORROWED from F9 (F9_SIGMA_WINDOW/F9_SIGMA_MIN_OBS) — ${id} declares no velocitySigma`;
const K = Number(arg("k") ?? own?.cusumK ?? F9_CUSUM_K);
const H_SWEEP = nums("h", [2, 3, 4, 5, 6, 8]);
const MULTS = nums("mult", [0.8, 1.0, 1.1, 1.5, 2.5]);
const storedFrom = arg("stored-from") ?? STORED_ERA_FROM;

// ── feed ──────────────────────────────────────────────────────────────────────────────────────
const obs = await fetchIndicatorObservations(indicator, { fullHistory: true }, new Date().toISOString(), env);
if (obs.length < sigmaCfg.window) {
  console.log(`⚠ feed is shorter (${obs.length}) than the σ window (${sigmaCfg.window}) — σ will degrade widely.`);
}
const dates = obs.map((o) => o.date);
const values = obs.map((o) => o.value);

console.log(`=== σ-z + CUSUM CANDIDACY — ${id} (${indicator.label}) ===`);
console.log(`feed        ${indicator.series} · n=${values.length} · ${dates[0]} … ${dates.at(-1)}`);
console.log(`velocity    Δ${w} (indicator.velocityWindow)`);
const blendArms = sigmaCfg.ewmaHalfLife === undefined
  ? "rect"
  : `blend ewmaHalfLife=${sigmaCfg.ewmaHalfLife} ewmaFloorFactor=${sigmaCfg.ewmaFloorFactor ?? 0}`;
console.log(`σ config    window=${sigmaCfg.window} minObs=${sigmaCfg.minObs} ${blendArms} — ${sigmaProvenance}`);
console.log(`cusum       k=${K} · h sweep ${H_SWEEP.join(",")} · reset-on-alarm (production velocityCusumSeries)`);
console.log(`σ multiples ${MULTS.join(",")}`);
console.log(
  `⚠ every σ/z/CUSUM number below is CONDITIONAL on that σ config (docblock invariant 1).\n` +
    `⚠ fires are SIGNED (\`Δ${w} >= cut\`) against a cut measured on |Δ${w}| (invariant 3).`,
);

// ── σ / z, production path ────────────────────────────────────────────────────────────────────
const { sigma, z } = velocitySigmaZSeries(values, w, sigmaCfg);
const zAt = (i: number) => z[i - VELOCITY_WINDOW]; // invariant 4
const sAt = (i: number) => sigma[i - VELOCITY_WINDOW];
const sgnDelta = (i: number) => values[i]! - values[i - w]!;
const allUsable = [...values.keys()].filter((i) => i >= VELOCITY_WINDOW && zAt(i) !== undefined);
if (allUsable.length === 0) throw new Error(`no usable-z day for ${id}: feed too short for minObs=${sigmaCfg.minObs}`);

// ── percentile baseline, both bases (invariant 2) ─────────────────────────────────────────────
function liveCutsFrom(from: string): { amber: number; red: number; n: number } {
  const v = obs.filter((o) => o.date >= from).map((o) => o.value);
  const absD: number[] = [];
  for (let i = w; i < v.length; i++) absD.push(Math.abs(v[i]! - v[i - w]!));
  return {
    amber: expandingPercentile(absD, SYNTH_AMBER_PCTILE).at(-1)!,
    red: expandingPercentile(absD, SYNTH_RED_PCTILE).at(-1)!,
    n: v.length,
  };
}
const cutFeed = liveCutsFrom(dates[0]!);
const cutStored = liveCutsFrom(storedFrom);
console.log(`\n## 0. PERCENTILE BASELINE RECONCILIATION (invariant 2 — which base the live cut uses)`);
console.log(row(["percentile base", "n obs", `amber p${SYNTH_AMBER_PCTILE * 100}`, `red p${SYNTH_RED_PCTILE * 100}`]));
console.log(row(["---", "---", "---", "---"]));
console.log(row([`full feed from ${dates[0]}`, cutFeed.n, cutFeed.amber.toFixed(4), cutFeed.red.toFixed(4)]));
console.log(row([`stored era from ${storedFrom}`, cutStored.n, cutStored.amber.toFixed(4), cutStored.red.toFixed(4)]));
console.log(
  `⇒ the STORED-era pair is the one to compare against prod's \`effAmber\`/\`effRed\`; a full-feed σ arm\n` +
    `  is judged against a base the live cut never sees.`,
);

// ── BLOCK 1: degeneracy / peg diagnostics ─────────────────────────────────────────────────────
console.log(`\n## 1. σ DEGENERACY — is there an era where σ collapses and z explodes?`);
const flat = new Set<number>();
for (let i = w; i < values.length; i++) if (values[i] === values[i - w]) flat.add(i);
let longest = 0;
let longestEnd = "";
let cur = 0;
for (let i = 1; i < values.length; i++) {
  if (values[i] === values[i - 1]) {
    cur++;
    if (cur > longest) {
      longest = cur;
      longestEnd = dates[i]!;
    }
  } else cur = 0;
}
const flatIdx = [...flat].sort((a, b) => a - b);
console.log(
  `Δ${w} exactly 0 on ${flat.size} of ${values.length - w} days (${pctOf(flat.size, values.length - w)})` +
    (flat.size ? `, ${dates[flatIdx[0]!]} … ${dates[flatIdx.at(-1)!]}` : ""),
);
console.log(`longest constant-value run: ${longest} observations, ending ${longestEnd}`);
const flatYears: string[] = [];
{
  const byY = new Map<string, { n: number; z: number }>();
  for (let i = w; i < values.length; i++) {
    const y = dates[i]!.slice(0, 4);
    const e = byY.get(y) ?? { n: 0, z: 0 };
    e.n++;
    if (flat.has(i)) e.z++;
    byY.set(y, e);
  }
  for (const [y, e] of [...byY].sort()) if (e.z / e.n > 0.5) flatYears.push(`${y}(${pctOf(e.z, e.n)})`);
}
console.log(`years >50% of days with Δ${w} exactly 0: ${flatYears.length ? flatYears.join(" ") : "(none)"}`);

const modernSigmas = allUsable.slice(-MODERN_TAIL).map((i) => sAt(i)!);
const modernMedian = median(modernSigmas);
console.log(`modern median σ (last ${Math.min(MODERN_TAIL, allUsable.length)} usable-z days): ${modernMedian.toExponential(3)}`);
console.log(`\n### σ bars — the earliest date from which σ never falls below the bar again`);
console.log(row(["bar", "σ value", "days below", "last day below", "⇒ σ stays above from"]));
console.log(row(["---", "---", "---", "---", "---"]));
const bars: Array<[string, number]> = [
  [`${DEGEN_FRACTION}× modern median (DEGEN bar)`, DEGEN_FRACTION * modernMedian],
  ...ABS_BAR_DECADES.map((f) => [`${f}× modern median`, f * modernMedian] as [string, number]),
];
let degenExit = dates[allUsable[0]!]!;
for (const [name, bar] of bars) {
  const below = allUsable.filter((i) => sAt(i)! < bar);
  const lastBelow = below.at(-1);
  const from = lastBelow === undefined ? dates[allUsable[0]!]! : (dates[lastBelow + 1] ?? "(never)");
  if (name.includes("DEGEN")) degenExit = from;
  console.log(
    row([name, bar.toExponential(3), below.length, lastBelow === undefined ? "—" : dates[lastBelow]!, from]),
  );
}
const zsAll = allUsable.map((i) => zAt(i)!);
const extreme = allUsable.filter((i) => Math.abs(zAt(i)!) > 10);
console.log(
  `|z| > 10 on ${extreme.length} days` +
    (extreme.length
      ? ` (${dates[extreme[0]!]} … ${dates[extreme.at(-1)!]}); max |z| ${Math.max(...zsAll.map(Math.abs)).toFixed(1)}`
      : ""),
);
if (extreme.length) {
  const top = [...allUsable].sort((a, b) => Math.abs(zAt(b)!) - Math.abs(zAt(a)!)).slice(0, 6);
  console.log(`top |z| days: ${top.map((i) => `${dates[i]} z=${zAt(i)!.toFixed(1)} σ=${sAt(i)!.toExponential(2)}`).join(" | ")}`);
  console.log(
    `⚠ an exploding z is a σ artefact, not a signal — check its SIGN before treating it as a fire:\n` +
      `  a HIGH id does not fire on a large NEGATIVE z.`,
  );
}
console.log(`\n### per-decade σ / raw-Δ dispersion (window-free sd is the peg detector)`);
console.log(row(["decade", "n usable-z", "σ min", "σ med", "σ max", `sd(Δ${w}) raw`, "z min", "z max"]));
console.log(row(["---", "---", "---", "---", "---", "---", "---", "---"]));
{
  const byDec = new Map<string, number[]>();
  for (const i of allUsable) {
    const d = `${dates[i]!.slice(0, 3)}0s`;
    if (!byDec.has(d)) byDec.set(d, []);
    byDec.get(d)!.push(i);
  }
  for (const [dec, idx] of [...byDec].sort()) {
    const ss = idx.map((i) => sAt(i)!);
    const zz = idx.map((i) => zAt(i)!);
    const dd = idx.map((i) => sgnDelta(i));
    console.log(
      row([
        dec,
        idx.length,
        Math.min(...ss).toExponential(2),
        median(ss).toExponential(2),
        Math.max(...ss).toExponential(2),
        stdev(dd).toExponential(2),
        Math.min(...zz).toFixed(2),
        Math.max(...zz).toFixed(2),
      ]),
    );
  }
}

// ── the three eras every later block is reported over ─────────────────────────────────────────
interface Era {
  name: string;
  from: string;
  /** The live percentile pair this era should be judged against (invariant 2). */
  cut: { amber: number; red: number };
  decision: boolean;
}
const eras: Era[] = [
  { name: "full feed", from: dates[allUsable[0]!]!, cut: cutFeed, decision: false },
  { name: `post-degenerate (σ ≥ ${DEGEN_FRACTION}× modern)`, from: degenExit, cut: cutFeed, decision: false },
  { name: `stored era (${storedFrom}+)`, from: storedFrom, cut: cutStored, decision: true },
];

// ── BLOCK 2: z distribution per era ───────────────────────────────────────────────────────────
console.log(`\n## 2. z DISTRIBUTION BY ERA`);
console.log(row(["era", "n usable-z", "span", "z min", "z max", "z mean", "|z| mean", `days z > k(${K})`]));
console.log(row(["---", "---", "---", "---", "---", "---", "---", "---"]));
const eraIdx = new Map<string, number[]>();
for (const e of eras) {
  const idx = allUsable.filter((i) => dates[i]! >= e.from);
  eraIdx.set(e.name, idx);
  const zz = idx.map((i) => zAt(i)!);
  console.log(
    row([
      e.name + (e.decision ? " ← DECISION ARM" : ""),
      idx.length,
      `${dates[idx[0]!]} … ${dates[idx.at(-1)!]}`,
      Math.min(...zz).toFixed(3),
      Math.max(...zz).toFixed(3),
      (zz.reduce((a, b) => a + b, 0) / zz.length).toFixed(4),
      (zz.reduce((a, b) => a + Math.abs(b), 0) / zz.length).toFixed(4),
      `${zz.filter((v) => v > K).length} (${pctOf(zz.filter((v) => v > K).length, zz.length)})`,
    ]),
  );
}

// ── BLOCK 3 + 4, per era ──────────────────────────────────────────────────────────────────────
/** Inline NO-RESET accumulator — the control (invariant 5), never a candidate shape. */
function cusumNoReset(zz: ReadonlyArray<number | undefined>, k: number): Array<number | undefined> {
  const out: Array<number | undefined> = [];
  let s = 0;
  for (const zi of zz) {
    if (zi === undefined) {
      out.push(undefined);
      continue;
    }
    s = Math.max(0, s + zi - k);
    out.push(s);
  }
  return out;
}

for (const e of eras) {
  const idx = eraIdx.get(e.name)!;
  const n = idx.length;
  console.log(`\n${"═".repeat(96)}`);
  console.log(`ERA: ${e.name}${e.decision ? "  ← DECISION ARM" : ""} — n=${n}, ${dates[idx[0]!]} … ${dates[idx.at(-1)!]}`);
  console.log(`percentile cut in force here: amber ${e.cut.amber.toFixed(4)} · red ${e.cut.red.toFixed(4)}`);

  // Arm A baseline — the percentile leg, production's signed comparison (invariant 3).
  const pctFired = idx.map((i) => sgnDelta(i) >= e.cut.amber);
  const pctSet = new Set(idx.filter((i) => sgnDelta(i) >= e.cut.amber).map((i) => dates[i]!));
  const redCount = idx.filter((i) => sgnDelta(i) >= e.cut.red).length;
  console.log(
    `\n## 3. ARM A/B — σ-z vs the percentile baseline\n` +
      `baseline: percentile amber ${pctSet.size} d (${pctOf(pctSet.size, n)}), ` +
      `${runLengths(pctFired).length} episodes, median run ${median(runLengths(pctFired))}; red ${redCount} d (${pctOf(redCount, n)})`,
  );
  console.log(row(["σ multiple", "fire days", "%", "episodes", "median run", "∩ pct", "σ-only (ADDS)", "pct-only", "Jaccard"]));
  console.log(row(["---", "---", "---", "---", "---", "---", "---", "---", "---"]));
  const zSets = new Map<number, Set<string>>();
  for (const m of MULTS) {
    const fired = idx.map((i) => zAt(i)! >= m);
    const set = new Set(idx.filter((i) => zAt(i)! >= m).map((i) => dates[i]!));
    zSets.set(m, set);
    const { inter, j } = jaccard(set, pctSet);
    console.log(
      row([
        `z ≥ ${m}σ`,
        set.size,
        pctOf(set.size, n),
        runLengths(fired).length,
        median(runLengths(fired)),
        inter,
        set.size - inter,
        pctSet.size - inter,
        j.toFixed(3),
      ]),
    );
  }
  const containing = MULTS.filter((m) => pctSet.size - jaccard(zSets.get(m)!, pctSet).inter === 0);
  if (containing.length) {
    console.log(
      `⚠ at ${containing.map((m) => `${m}σ`).join("/")} the σ set STRICTLY CONTAINS the percentile set ` +
        `(pct-only = 0) — that arm is the SAME signal at a looser gate, not a new input.`,
    );
  }

  // Block 4 — the h sweep, reset (production) + no-reset control.
  const z08 = zSets.get(MULTS[0]!)!;
  const zHi = zSets.get(MULTS.at(-1)!)!;
  console.log(
    `\n## 4. h SWEEP — production velocityCusumSeries (RESET-on-alarm), k=${K}\n` +
      `marginal columns are days the cusum leg ADDS beyond the named union.`,
  );
  console.log(
    row([
      "h",
      "fire days",
      "%",
      "episodes",
      "median run",
      "peak S⁺",
      "+ beyond pct",
      `+ beyond pct ∪ z@${MULTS[0]}σ`,
      `+ beyond pct ∪ z@${MULTS.at(-1)}σ`,
    ]),
  );
  console.log(row(["---", "---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const h of H_SWEEP) {
    const cus = velocityCusumSeries(z, K, h);
    const cAt = (i: number) => cus[i - VELOCITY_WINDOW];
    const fired = idx.map((i) => (cAt(i) ?? -1) >= h);
    const set = new Set(idx.filter((i) => (cAt(i) ?? -1) >= h).map((i) => dates[i]!));
    const peak = Math.max(...idx.map((i) => cAt(i) ?? 0));
    console.log(
      row([
        h,
        set.size,
        pctOf(set.size, n),
        runLengths(fired).length,
        median(runLengths(fired)),
        peak.toFixed(2),
        [...set].filter((d) => !pctSet.has(d)).length,
        [...set].filter((d) => !pctSet.has(d) && !z08.has(d)).length,
        [...set].filter((d) => !pctSet.has(d) && !zHi.has(d)).length,
      ]),
    );
    if (wantDates && set.size) {
      const only = [...set].filter((d) => !pctSet.has(d) && !z08.has(d));
      console.log(`  h=${h} marginal dates (capped ${MAX_DATES}): ${only.slice(0, MAX_DATES).join(" ") || "(none)"}`);
    }
  }
  // The control. One h is enough — it is a ratchet demonstration, not a sweep.
  const hCtl = H_SWEEP[Math.min(1, H_SWEEP.length - 1)]!;
  const raw = cusumNoReset(z, K);
  const rAt = (i: number) => raw[i - VELOCITY_WINDOW];
  const ctlFired = idx.map((i) => (rAt(i) ?? -1) >= hCtl);
  console.log(
    `NO-RESET CONTROL (h=${hCtl}, invariant 5 — not a candidate): ` +
      `${ctlFired.filter(Boolean).length} fire days (${pctOf(ctlFired.filter(Boolean).length, n)}), ` +
      `${runLengths(ctlFired).length} episodes, peak S⁺ ${Math.max(...idx.map((i) => rAt(i) ?? 0)).toFixed(1)}`,
  );
}

// ── BLOCK 6: the TWO-BOUND arm — production's real shape (AMBER fire test, RED reset) ─────────
/**
 * Block 4 sweeps ONE bound used as both the fire test and the reset point. Production has not had
 * that shape since 2026-08-09: `deriveConfirmedState` passes `cusumRedBound` as the reset (the `h`
 * argument) while `legBounds` tests AMBER separately at `cusumH`. So block 4 can report a red share
 * and can NEVER report the amber share at any `k` — the structural gap that shipped rounds 4 and 5
 * unmeasured.
 * ⛔ Block 4 is deliberately left as-is: it is the provenance baseline those rounds were ruled off.
 * This arm reproduces the production PAIR — one accumulator, reset at RED, fire-tested at both.
 *
 * ⚠ The `k` sweep is the point, not a garnish. It exists because `F9_CUSUM_K` shipped for rounds BELOW
 * the in-control level of its own input, giving S⁺ positive expected drift with nothing happening; the
 * offset estimators that closed that gap, and every `k` this leg has carried since, are in
 * `docs/indicator-cut-provenance.md` §F9. ⛔ Read no `k` or z-mean figure off this docblock — the shipped
 * value is `src/registry.ts`'s and nowhere else.
 * ⚠ The sweep varies `k` at the REGISTRY bounds only, so no row here describes a different `h`.
 */
{
  const e = eras.find((x) => x.decision)!;
  const idx = eraIdx.get(e.name)!;
  const n = idx.length;
  const amberH = Number(arg("amber-h") ?? own?.cusumH ?? F9_CUSUM_H);
  const redH = Number(arg("red-h") ?? own?.cusumHRed ?? F9_CUSUM_H_RED);
  const K_SWEEP = nums("k-sweep", [0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7]);
  console.log(`\n${"═".repeat(96)}`);
  console.log(`## 6. TWO-BOUND ARM — amber ${amberH} (fire test) · red ${redH} (fire test AND reset)`);
  console.log(`era         ${e.name} ← DECISION ARM · n=${n} · ${dates[idx[0]!]} … ${dates[idx.at(-1)!]}`);
  console.log(
    `⚠ the AMBER columns are the ones that have never been measured; block 4's single-bound sweep\n` +
      `  cannot produce them, so no amber figure predating this block describes this leg.`,
  );
  console.log(
    row(["k", "amber days", "amber %", "amber eps", "amber med run", "red days", "red %", "red eps", "red med run", "peak S⁺"]),
  );
  console.log(row(new Array(10).fill("---")));
  for (const k of K_SWEEP) {
    // ONE accumulator, production's shape: the reset bound is RED, per `cusumRedBound`.
    const cus = velocityCusumSeries(z, k, redH);
    const cAt = (i: number) => cus[i - VELOCITY_WINDOW];
    const amberFired = idx.map((i) => (cAt(i) ?? -1) >= amberH);
    const redFired = idx.map((i) => (cAt(i) ?? -1) >= redH);
    const aN = amberFired.filter(Boolean).length;
    const rN = redFired.filter(Boolean).length;
    console.log(
      row([
        k,
        aN,
        pctOf(aN, n),
        runLengths(amberFired).length,
        median(runLengths(amberFired)),
        rN,
        pctOf(rN, n),
        runLengths(redFired).length,
        median(runLengths(redFired)),
        Math.max(...idx.map((i) => cAt(i) ?? 0)).toFixed(2),
      ]),
    );
  }

  // ── the in-control OFFSET candidates ────────────────────────────────────────────────────────
  /**
   * A CUSUM cumulates deviation from a TARGET. This one declares its target implicitly as 0 while
   * its input sits above it — the drift §3.9 ruled a FIXED offset against, folded into `k`.
   * The full-sample mean is the CONTAMINATED baseline: every genuine drift episode in the era
   * raised it, so choosing it desensitizes the leg with the signal it exists to detect. It is
   * printed only to give the robust rows something to be compared against.
   * ⛔ The IN-CONTROL row is ONE-SIDED and therefore NOT comparable to the rows above it. It removes
   * only the upper tail (the days the percentile amber leg fires), so on a right-skewed z it is
   * biased DOWNWARD as a location estimate — it is not "the textbook reference period", and reading
   * it as the in-control mean would over-correct the offset by removing the very excursions the leg
   * exists to accumulate. The symmetric rows (median, trimmed means) are the comparable ones.
   */
  const zz = idx.map((i) => zAt(i)!);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const trimmed = (a: number[], frac: number) => {
    const s = [...a].sort((x, y) => x - y);
    const cut = Math.floor(s.length * frac);
    return mean(s.slice(cut, s.length - cut));
  };
  const inControl = idx.filter((i) => sgnDelta(i) < e.cut.amber).map((i) => zAt(i)!);
  console.log(`\n### 6b. IN-CONTROL OFFSET CANDIDATES — what "normal drift" is, over the decision arm`);
  console.log(row(["estimator", "n", "offset", `⇒ k at sensitivity 0.10`, "note"]));
  console.log(row(["---", "---", "---", "---", "---"]));
  const offRow = (label: string, v: number, nn: number, note: string) =>
    console.log(row([label, nn, v.toFixed(4), (v + 0.1).toFixed(4), note]));
  offRow("full-sample mean", mean(zz), zz.length, "CONTAMINATED — inflated by the episodes we catch");
  offRow("median", median(zz), zz.length, "robust to the episode tail");
  offRow("10% trimmed mean", trimmed(zz, 0.1), zz.length, "robust, keeps the bulk");
  offRow("20% trimmed mean", trimmed(zz, 0.2), zz.length, "robust, heavier trim");
  offRow("in-control mean ⛔", mean(inControl), inControl.length, `ONE-SIDED (drops z where Δ ≥ ${e.cut.amber.toFixed(4)}) — biased LOW, not comparable`);
  console.log(
    `⚠ these are RECORDS, not a gate (§3.8) — nothing here may auto-retune \`F9_CUSUM_K\`.\n` +
      `⇒ Stage K values \`k\` from a row above PLUS a chosen sensitivity; the sensitivity column\n` +
      `  restates today's 0.10 only as a worked example, never as the ruled value.`,
  );
}

// ── BLOCK 5 (opt-in): would an `m × σ(t)` cut line be VISIBLE on the detail chart? ────────────
if (wantVisibility) {
  const N = Number(arg("vis-window") ?? DETAIL_LIMIT);
  const visMults = nums("vis-mult", [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.5]);
  const winIdx = allUsable.slice(-N);
  // `genericSingle`'s frame, verbatim (invariant 7): the SERIES alone, ±8% of its own range.
  const seriesVals = winIdx.map((i) => sgnDelta(i));
  let lo = Math.min(...seriesVals);
  let hi = Math.max(...seriesVals);
  const padY = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  const dLo = lo;
  const dHi = hi;
  lo -= padY;
  hi += padY;
  const winSigmas = winIdx.map((i) => sAt(i)!);
  const maxSigma = Math.max(...winSigmas);
  console.log(`\n${"═".repeat(96)}`);
  console.log(`## 5. CUT VISIBILITY — would an \`m × σ(t)\` line be drawn, or degrade to a ▲ edge marker?`);
  console.log(`window      trailing ${winIdx.length} obs · ${dates[winIdx[0]!]} … ${dates[winIdx.at(-1)!]}`);
  console.log(`Δ${w} domain  ${dLo.toFixed(4)} … ${dHi.toFixed(4)} · pad ${padY.toFixed(4)} · frame [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
  console.log(
    `σ(t) window min ${Math.min(...winSigmas).toFixed(4)} · med ${median(winSigmas).toFixed(4)} · ` +
      `max ${maxSigma.toFixed(4)} · first ${winSigmas[0]!.toFixed(4)} → last ${winSigmas.at(-1)!.toFixed(4)}`,
  );
  console.log(
    `⚠ an in-frame count is a statement about THIS WINDOW, not about the cut (invariant 7).\n` +
      `⇒ CEILING: the whole line sits inside the frame only while m ≤ frameTop/max σ = ` +
      `**${(hi / maxSigma).toFixed(4)}**; the window's own Δ${w} peak is ${(dHi / median(winSigmas)).toFixed(3)}σ at median σ.`,
  );
  const storedIdx = eraIdx.get(eras.find((e) => e.decision)!.name)!;
  console.log(
    row(["m", "line min…max", "in frame", "%", "window fires", "stored-era fires", "% stored era"]),
  );
  console.log(row(["---", "---", "---", "---", "---", "---", "---"]));
  for (const m of visMults) {
    const line = winIdx.map((i) => m * sAt(i)!);
    // The predicate `genericSingle` actually applies to each per-point cut.
    const inFrame = line.filter((v) => v >= lo && v <= hi).length;
    const winFires = winIdx.filter((i) => zAt(i)! >= m).length;
    const stFires = storedIdx.filter((i) => zAt(i)! >= m).length;
    console.log(
      row([
        `${m}σ`,
        `${Math.min(...line).toFixed(4)} … ${Math.max(...line).toFixed(4)}`,
        inFrame,
        pctOf(inFrame, winIdx.length),
        winFires,
        stFires,
        pctOf(stFires, storedIdx.length),
      ]),
    );
  }
  console.log(`\n### window-length sweep — does a WIDER \`chart.window\` fix it without moving the cut?`);
  console.log(row(["trailing N", "span", `Δ${w} domain`, "frame top", ...visMults.map((m) => `${m}σ in frame`)]));
  console.log(row(["---", "---", "---", "---", ...visMults.map(() => "---")]));
  for (const nn of [N, 500, 750, 1000, 1500, 2000, 3000, storedIdx.length]) {
    const idx = allUsable.slice(-nn);
    if (idx.length < 2) continue;
    const dv = idx.map((i) => sgnDelta(i));
    const l = Math.min(...dv);
    const h = Math.max(...dv);
    const pd = (h - l) * 0.08 || Math.abs(h) * 0.1 || 1;
    const LO = l - pd;
    const HI = h + pd;
    console.log(
      row([
        idx.length,
        `${dates[idx[0]!]}…${dates[idx.at(-1)!]}`,
        `${l.toFixed(4)} … ${h.toFixed(4)}`,
        HI.toFixed(4),
        ...visMults.map((m) => {
          const c = idx.filter((i) => {
            const v = m * sAt(i)!;
            return v >= LO && v <= HI;
          }).length;
          return pctOf(c, idx.length);
        }),
      ]),
    );
  }
}

console.log(
  `\n${"═".repeat(96)}\nREAD THE DECISION ARM ONLY. The full-feed and post-degenerate eras are context: a σ leg fitted\n` +
    `to a base the live cut never sees (invariant 2) cannot be compared against a cut taken from the store.`,
);
