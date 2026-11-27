/**
 * σ-RESPONSIVENESS PROBE — "how far behind the current volatility regime does this id's dynamic
 * velocity band sit, and what do faster σ estimators do to its fire rate and its episodes?"
 *
 *   npm run probe:sigma-response -- --id=F11
 *   npx tsx scripts/probe-sigma-response.ts --id=F9 --windows=1260,504 --ewma=125,60 --chart
 *   npx tsx scripts/probe-sigma-response.ts --id=F11 --csv=scripts/backtest/data/cny.csv
 *
 * READ-ONLY and STORE-FREE: the only IO is the keyless FRED fetch (or `--csv=`). Prints AGGREGATE
 * COUNTS ONLY — no per-day log. Sibling instrument: `probe-sigma-cusum-candidacy.ts` answers
 * whether a σ leg belongs on an id at all; this one answers how fast its σ should adapt.
 *
 * ═══ INVARIANTS THAT BIND A RE-RUN ═══════════════════════════════════════════════════════════
 *
 * ⚠ **1. EVERY VARIANT IS INDEXED BY OBSERVATION, NEVER BY ARRAY SLOT.** `velocitySigmaZSeries`
 * walks from the GLOBAL `VELOCITY_WINDOW`, not from the id's `velocityWindow`, so a hand-rolled
 * estimator that starts at `w` is offset by `w − VELOCITY_WINDOW`. Go through `Variant.sigmaAt(i)`.
 *
 * ⚠ **2. THE σ CONFIG AND THE MULTIPLES ARE BORROWED FOR ANY ID THAT LACKS THEM.** Only an id
 * carrying `thresholds.velocitySigma` states cuts in σ; for every other id the registry velocity
 * pair is in RAW units and `--multiples=` is REQUIRED. The header prints OWN vs BORROWED — a fire
 * rate from a borrowed pair is evidence about that pair, not about the id.
 *
 * ⚠ **3. THE FIRE TEST IS ONE-SIDED AND ORIENTED.** `evaluateLegs` compares the SIGNED Δw, so a
 * `direction: "LOW"` id fires on `z ≤ −cut`. Both are folded into `orientedZ`; a two-sided count
 * would be roughly double and would be wrong.
 *
 * ⚠ **4. THE DIAGNOSTIC ERA IS DERIVED, NOT HAND-LISTED.** A peg or any other variance collapse
 * makes σ ≈ 0 and z explode, which would dominate every correlation. The era starts after the last
 * day whose LIVE σ sits below `DEGEN_FRACTION` of the modern median; `--from=` overrides.
 *
 * ⚠ **5. THE LAG IS MEASURED AGAINST A NON-CAUSAL TRUTH AND IS A COMPARISON, NOT AN ABSOLUTE.**
 * Truth is the sd of Δw over a CENTRED ±`TRUTH_HALF` window, so no causal estimator can score 0;
 * read the lag column as variant-vs-variant distance, never as an error bar.
 *
 * ⚠ **6. EPISODES ARE DERIVED FROM THE ORIENTED Δw, NOT FROM ANY VARIANT'S z.** Peaks are picked
 * variant-free so the per-variant max-z columns stay comparable across arms.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { fetchIndicatorObservations } from "../src/indicator-feed.js";
import { velocitySigmaZSeries } from "../src/domain-fold.js";
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import { F9_SIGMA_WINDOW, F9_SIGMA_MIN_OBS } from "../src/registry-fred.js";
import { readFileSync } from "node:fs";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

/** Fraction of the MODERN median σ below which a day counts as degenerate (invariant 4). */
const DEGEN_FRACTION = 0.1;
/** Trailing usable days defining "modern" for that median. ~5 trading years. */
const MODERN_TAIL = 1260;
/** Half-width of the centred window defining the non-causal truth scale (invariant 5). */
const TRUTH_HALF = 120;
/** Lag search grid, in observations. `--lag-max=` widens it; a lag AT the ceiling is a floor, not a value. */
const LAG_MAX_DEFAULT = 1200;
const LAG_STEP = 5;
/** Derived-episode count, half-width, and minimum separation — all in observations. */
const EPISODES = 6;
const EPISODE_HALF = 60;
const EPISODE_SEP = 90;
/** Where the `readings` store's history begins — the era a live cut is really exercised over. */
const STORED_ERA_FROM = "2011-08-02";

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
const id = arg("id");
if (!id) throw new Error("--id=<INDICATOR_ID> is required");
const indicator = ALL_INDICATORS.find((i) => i.id === id);
if (!indicator) throw new Error(`--id=${id}: no such indicator`);

const t = indicator.thresholds ?? {};
const own = t.velocitySigma;
const sigmaWindow = Number(arg("sigma-window") ?? own?.window ?? F9_SIGMA_WINDOW);
const sigmaMinObs = Number(arg("sigma-min-obs") ?? own?.minObs ?? F9_SIGMA_MIN_OBS);
const cliMultiples = arg("multiples")?.split(",").map(Number);
if (!own && !cliMultiples)
  throw new Error(`--id=${id} carries no thresholds.velocitySigma ⇒ its registry velocity pair is in RAW units. Pass --multiples=<amber>,<red>.`);
const [AMBER, RED] = (cliMultiples ?? [t.amberVelocity, t.redVelocity]) as [number, number];
if (!Number.isFinite(AMBER) || !Number.isFinite(RED))
  throw new Error(`--id=${id}: no resolvable amber/red multiple — pass --multiples=<amber>,<red>.`);

const w = indicator.velocityWindow ?? VELOCITY_WINDOW;
const isLow = indicator.direction === "LOW";
const wantChart = process.argv.includes("--chart");
const storedFrom = arg("stored-from") ?? STORED_ERA_FROM;

// ── feed ──────────────────────────────────────────────────────────────────────────────────────
const csvPath = arg("csv");
const obs = csvPath
  ? readFileSync(csvPath, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(","))
      .filter((c) => c[1] !== undefined && c[1] !== "." && Number.isFinite(Number(c[1])))
      .map((c) => ({ date: c[0]!, value: Number(c[1]) }))
  : await (async () => {
      if (!indicator.series)
        throw new Error(`--id=${id} has no \`series\` (derived id) — pass --csv=<path>.`);
      // Dispatches on `FEED_OF` (registry.ts) — a σ id off FRED would otherwise be probed on the
      // wrong feed the day it moves to prices.
      return fetchIndicatorObservations(indicator, { fullHistory: true }, new Date().toISOString(), env);
    })();
const dates = obs.map((o) => o.date);
const values = obs.map((o) => o.value);
const n = values.length;
if (n < w + sigmaMinObs + 2) throw new Error(`--id=${id}: only ${n} observations — too few for w=${w}, minObs=${sigmaMinObs}.`);

/** The SCORED delta at observation `i`, head clamp included — the same number the card carries. */
const delta = (i: number) => (i - w >= 0 ? values[i]! - values[i - w]! : values[i]! - values[0]!);
/** Signed so that "more danger" is always POSITIVE, whatever the id's polarity (invariant 3). */
const oriented = (i: number) => (isLow ? -delta(i) : delta(i));

// ── variants ──────────────────────────────────────────────────────────────────────────────────
type Variant = { name: string; sigmaAt: (i: number) => number | undefined };

/**
 * ONE IMPLEMENTATION: every arm — rectangular,
 * EWMA and blend alike — is `velocitySigmaZSeries`, so re-running this probe IS the port's falsifier.
 */
const variant = (cfg: { window: number; minObs: number; ewmaHalfLife?: number; ewmaFloorFactor?: number }, name: string): Variant => {
  const s = velocitySigmaZSeries(values, w, cfg).sigma;
  return { name, sigmaAt: (i) => s[i - VELOCITY_WINDOW] }; // invariant 1
};
const rect = (window: number, minObs: number, name: string): Variant => variant({ window, minObs }, name);
const blendName = (hl: number, f: number, window: number) => `blend max(ewma${hl}, ${f}·rect ${window})`;

// LIVE is the id's CONFIGURED estimator — for a blended id that is the blend, not the rect arm.
const liveCfg = { window: sigmaWindow, minObs: sigmaMinObs, ewmaHalfLife: own?.ewmaHalfLife, ewmaFloorFactor: own?.ewmaFloorFactor };
const live = variant(
  liveCfg,
  `${own?.ewmaHalfLife === undefined ? `rect ${sigmaWindow}` : blendName(own.ewmaHalfLife, own.ewmaFloorFactor ?? 0, sigmaWindow)} (LIVE)`,
);
const variants: Variant[] = [live];
// The rect arm at `sigmaWindow` is LIVE only while LIVE is rectangular; under a blend it is the FLOOR arm
// and must still print, or the table loses the arm the floor is taken against.
const floorArm = own?.ewmaHalfLife === undefined ? undefined : rect(sigmaWindow, sigmaMinObs, `rect ${sigmaWindow} (floor arm)`);
if (floorArm) variants.push(floorArm);
for (const win of nums("windows", [756, 504, 252])) if (win !== sigmaWindow) variants.push(rect(win, Math.min(sigmaMinObs, win), `rect ${win}`));
for (const hl of nums("ewma", [250, 125, 60])) variants.push(variant({ window: sigmaWindow, minObs: sigmaMinObs, ewmaHalfLife: hl }, `ewma hl=${hl}`));
const floor = Number(arg("floor") ?? own?.ewmaFloorFactor ?? 0.75);
const fastHl = nums("ewma", [250, 125, 60])[1] ?? 125;
// ⛔ The floor references an EXPLICIT rect arm at `sigmaWindow`, never `live` — post-port `live` IS the
// blend for F11, and a floor taken against the blend is degenerate. Defaulting `--floor` to the id's own
// factor makes this arm COINCIDE with LIVE (the self-check); `--floor=` sweeps it away from LIVE.
variants.push(variant({ window: sigmaWindow, minObs: sigmaMinObs, ewmaHalfLife: fastHl, ewmaFloorFactor: floor }, blendName(fastHl, floor, sigmaWindow)));

const usable = [...values.keys()].filter((i) => i >= VELOCITY_WINDOW);
const zOf = (v: Variant, i: number) => {
  const s = v.sigmaAt(i);
  return s === undefined ? undefined : oriented(i) / s;
};

// ── derived diagnostic era (invariant 4) ──────────────────────────────────────────────────────
// ⛔ The era anchors on the rect FLOOR arm, never `live` — under a blend `live` IS the estimator under
// test, so a derived era would drift with every knob move and re-base every era-scoped column.
const eraArm = floorArm ?? live;
const eraDays = usable.filter((i) => eraArm.sigmaAt(i) !== undefined);
const modern = eraDays.slice(-MODERN_TAIL).map((i) => eraArm.sigmaAt(i)!).sort((a, b) => a - b);
const modernMedian = modern[modern.length >> 1] ?? NaN;
const lastDegen = [...eraDays].reverse().find((i) => eraArm.sigmaAt(i)! < DEGEN_FRACTION * modernMedian);
const diagFrom = arg("from") ?? (lastDegen === undefined ? dates[eraDays[0] ?? 0]! : dates[lastDegen + 1] ?? dates[n - 1]!);

// ── formatting ────────────────────────────────────────────────────────────────────────────────
const pad = (s: string, width: number) => s.padEnd(width);
const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "—");

console.log(`\n═══ σ-RESPONSIVENESS · ${id} (${indicator.label}) ═══`);
console.log(`  feed        ${csvPath ?? `FRED ${indicator.series}`} — ${n} obs, ${dates[0]} → ${dates[n - 1]}`);
console.log(`  Δ window    w=${w} ${indicator.velocityWindow ? "(id's own velocityWindow)" : "(global VELOCITY_WINDOW)"}, direction ${isLow ? "LOW" : "HIGH"}`);
console.log(`  σ config    window=${sigmaWindow} minObs=${sigmaMinObs} ${own ? "(OWN)" : "(BORROWED from F9)"}`);
console.log(`  multiples   amber=${AMBER} red=${RED} ${cliMultiples ? "(--multiples)" : own ? "(OWN, σ-valued)" : "(BORROWED)"}`);
console.log(`  diag era    ${diagFrom} ${arg("from") ? "(--from)" : `(derived on ${eraArm.name}: last σ < ${DEGEN_FRACTION}× modern median ${num(modernMedian, 4)})`}`);

// ── block 1 · responsiveness + fire rate ──────────────────────────────────────────────────────
const truthAt = (() => {
  const cache = new Map<number, number | undefined>();
  return (i: number) => {
    if (cache.has(i)) return cache.get(i);
    const a = Math.max(VELOCITY_WINDOW, i - TRUTH_HALF);
    const b = Math.min(n - 1, i + TRUTH_HALF);
    const win: number[] = [];
    for (let k = a; k <= b; k++) win.push(delta(k));
    const m = win.reduce((x, y) => x + y, 0) / win.length;
    const v = win.reduce((x, y) => x + (y - m) ** 2, 0) / (win.length - 1);
    const out = v > 0 ? Math.sqrt(v) : undefined;
    cache.set(i, out);
    return out;
  };
})();

const diagDays = usable.filter((i) => dates[i]! >= diagFrom);

// Bind share — the diag-era fraction on which `floor × rect` WINS the max, i.e. how live the floor arm is.
if (floorArm) {
  const ewmaOnly = variant({ window: sigmaWindow, minObs: sigmaMinObs, ewmaHalfLife: fastHl }, "");
  let bind = 0;
  let both = 0;
  for (const i of diagDays) {
    const r = floorArm.sigmaAt(i);
    const e = ewmaOnly.sigmaAt(i);
    if (r === undefined || e === undefined) continue;
    both++;
    if (floor * r >= e) bind++;
  }
  console.log(`  bind share  ${pct(bind, both)}% of ${both} diag-era days — floor=${floor} × rect ${sigmaWindow} wins over ewma hl=${fastHl}`);
}

function lagCorr(v: Variant, lag: number): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const i of diagDays) {
    const s = v.sigmaAt(i);
    const tr = truthAt(i - lag);
    if (s !== undefined && tr !== undefined) {
      xs.push(Math.log(s));
      ys.push(Math.log(tr));
    }
  }
  if (xs.length < 250) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k]! - mx) * (ys[k]! - my);
    sxx += (xs[k]! - mx) ** 2;
    syy += (ys[k]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const lastDate = dates[n - 1]!;
const yearsAgo = (y: number) => {
  const d = new Date(`${lastDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - y);
  return isoDay(d);
};
const eras: Array<[string, string]> = [
  ["diag-era", diagFrom],
  ["stored", storedFrom > diagFrom ? storedFrom : diagFrom],
  ["last 3y", yearsAgo(3)],
  ["last 1y", yearsAgo(1)],
];

console.log(`\n── responsiveness + fire rate (amber ${AMBER}σ / red ${RED}σ, % of scored days) ──`);
// `corr@0` is the monotone-safe reading: contemporaneous agreement with the local truth scale.
// `lag` is the argmax, which can jump discontinuously when the surface is flat — read them together.
const lagMax = Number(arg("lag-max") ?? LAG_MAX_DEFAULT);
console.log(pad("variant", 30) + pad("corr@0", 8) + pad("lag", 6) + pad("corr", 7) + pad("σp90/p10", 10) + eras.map(([e]) => pad(`A/R ${e}`, 17)).join(""));
for (const v of variants) {
  const corr0 = lagCorr(v, 0);
  let best = { lag: 0, c: -2 };
  for (let lag = 0; lag <= lagMax; lag += LAG_STEP) {
    const c = lagCorr(v, lag);
    if (Number.isFinite(c) && c > best.c) best = { lag, c };
  }
  const sig = diagDays.map((i) => v.sigmaAt(i)).filter((s): s is number => s !== undefined).sort((a, b) => a - b);
  const q = (p: number) => sig[Math.floor(p * (sig.length - 1))] ?? NaN;
  const cells = eras.map(([, from]) => {
    let tot = 0;
    let amb = 0;
    let red = 0;
    for (const i of usable) {
      if (dates[i]! < from) continue;
      tot++;
      const z = zOf(v, i);
      if (z === undefined) continue;
      if (z >= RED) red++;
      else if (z >= AMBER) amb++;
    }
    return pad(`${pct(amb, tot)}/${pct(red, tot)}%`, 17);
  });
  console.log(
    pad(v.name, 30) +
      pad(num(corr0, 3), 8) +
      pad(best.lag >= lagMax ? `≥${lagMax}` : String(best.lag), 6) +
      pad(num(best.c, 3), 7) +
      pad(num(q(0.9) / q(0.1), 2), 10) +
      cells.join(""),
  );
}

// ── block 2 · derived episodes (invariant 6) ──────────────────────────────────────────────────
const peaks: number[] = [];
for (const i of [...diagDays].sort((a, b) => oriented(b) - oriented(a))) {
  if (peaks.length >= EPISODES) break;
  if (peaks.every((p) => Math.abs(p - i) >= EPISODE_SEP)) peaks.push(i);
}
peaks.sort((a, b) => a - b);
console.log(`\n── episodes (top ${peaks.length} oriented-Δ${w} peaks, ±${EPISODE_HALF}d) · max z (amber/red days) ──`);
console.log(pad("variant", 30) + peaks.map((p) => pad(dates[p]!.slice(0, 7), 18)).join(""));
for (const v of variants) {
  const cells = peaks.map((p) => {
    let maxZ = -Infinity;
    let amb = 0;
    let red = 0;
    for (let i = Math.max(VELOCITY_WINDOW, p - EPISODE_HALF); i <= Math.min(n - 1, p + EPISODE_HALF); i++) {
      const z = zOf(v, i);
      if (z === undefined) continue;
      if (z > maxZ) maxZ = z;
      if (z >= RED) red++;
      else if (z >= AMBER) amb++;
    }
    return pad(`${num(maxZ, 2)} (${amb}/${red})`, 18);
  });
  console.log(pad(v.name, 30) + cells.join(""));
}

// ── block 3 · chatter + today's drawn lines ───────────────────────────────────────────────────
console.log(`\n── amber+ blocks over the diag era (raw, pre-fold) · and the line drawn at ${lastDate} ──`);
console.log(pad("variant", 30) + pad("blocks", 8) + pad("days", 7) + pad("mean len", 10) + pad("σ today", 10) + pad(`amber (Δ${w})`, 14) + pad("red", 12));
for (const v of variants) {
  let blocks = 0;
  let days = 0;
  let inBlock = false;
  for (const i of diagDays) {
    const z = zOf(v, i);
    const hit = z !== undefined && z >= AMBER;
    if (hit) {
      days++;
      if (!inBlock) blocks++;
    }
    inBlock = hit;
  }
  const s = v.sigmaAt(n - 1);
  console.log(
    pad(v.name, 30) +
      pad(String(blocks), 8) +
      pad(String(days), 7) +
      pad(num(days / (blocks || 1)), 10) +
      pad(s === undefined ? "—" : s.toFixed(4), 10) +
      pad(s === undefined ? "—" : (AMBER * s).toFixed(4), 14) +
      pad(s === undefined ? "—" : (RED * s).toFixed(4), 12),
  );
}
console.log(`  current oriented Δ${w} = ${oriented(n - 1).toFixed(4)} (fires amber above the amber column)`);

// ── block 4 · optional ASCII of the drawn band ────────────────────────────────────────────────
if (wantChart) {
  const COLS = 62;
  const ROWS = 11;
  const step = diagDays.length / COLS;
  for (const v of variants.slice(1)) {
    const peak: number[] = [];
    const l: number[] = [];
    const c: number[] = [];
    for (let col = 0; col < COLS; col++) {
      const a = Math.floor(col * step);
      const b = Math.max(a, Math.floor((col + 1) * step) - 1);
      let mx = -Infinity;
      let sl = 0;
      let sc = 0;
      let cnt = 0;
      for (let k = a; k <= b && k < diagDays.length; k++) {
        const i = diagDays[k]!;
        mx = Math.max(mx, oriented(i));
        sl += live.sigmaAt(i) ?? 0;
        sc += v.sigmaAt(i) ?? 0;
        cnt++;
      }
      peak.push(mx);
      l.push((AMBER * sl) / (cnt || 1));
      c.push((AMBER * sc) / (cnt || 1));
    }
    const top = Math.max(...peak, ...l, ...c);
    const rowVal = (y: number) => ((ROWS - 1 - y) / (ROWS - 1)) * top;
    const grid: string[][] = Array.from({ length: ROWS }, () => Array<string>(COLS).fill(" "));
    const plot = (arr: number[], ch: string) => {
      for (let col = 0; col < COLS; col++) {
        let bestY = 0;
        let bd = Infinity;
        for (let y = 0; y < ROWS; y++) {
          const d = Math.abs(rowVal(y) - arr[col]!);
          if (d < bd) {
            bd = d;
            bestY = y;
          }
        }
        grid[bestY]![col] = grid[bestY]![col] === " " ? ch : "#";
      }
    };
    plot(peak, "·");
    plot(l, "-");
    plot(c, "=");
    console.log(`\n  ${v.name}   ( · peak Δ${w}   - LIVE ${AMBER}σ   = candidate ${AMBER}σ )`);
    grid.forEach((g, y) => console.log(`  ${rowVal(y).toFixed(2).padStart(6)} |${g.join("")}`));
    console.log(`         +${"-".repeat(COLS)}`);
    console.log(`          ${dates[diagDays[0]!]}${" ".repeat(Math.max(1, COLS - 21))}${lastDate}`);
  }
}
