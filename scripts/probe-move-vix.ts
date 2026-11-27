/**
 * Read-only probe: is `R6` (MOVE, bond vol) a DISTINCT factor, or an echo of `R5` (VIX, equity
 * vol)? Written 2026-07-26 to adjudicate
 * `MEMBER_WEIGHT.R6` (`src/danger-ladder.ts`) — a row reassigned
 * volatility→rates at the Stage-1.2 taxonomy merge with "weights unchanged", i.e. the family moved
 * and the row did not.
 *
 *   npm run probe:move-vix        # offline, reads committed fixtures, writes NOTHING
 *
 * WHY IT MATTERS HERE. R6's registry docblock (`src/registry.ts`) asserts "VIX/MOVE corr ≈0.93" as
 * the ground for translating VIX cuts onto MOVE. If that holds at the project's same-factor line
 * (Δ20 r ≥ 0.90, `probe-bund-eurc.ts` §3.2) then R6 is a second copy of R5 sitting in a DIFFERENT
 * family — importing equity vol into the rates cell — and its weights are R5's, not a rates row's.
 * If it does not hold, R6 is its own factor and its four non-zero cells owe their own mechanism.
 *
 * Metric shapes are `probe-eurc-ust.ts`'s, so the two rungs' numbers read on one axis:
 *
 *   M1  Pearson r of daily LEVELS
 *   M2  Pearson r of 20d CHANGES (dynamics, not the shared vol trend) — the same-factor metric
 *   Δ1  Pearson r of 1d CHANGES, printed beside M2 so a Δ20 reading can be told from same-day
 *       mechanical co-movement
 *   M4  MARGINAL firing days — MOVE at/over its cut while VIX is NOT at its own
 *   LL  lead/lag — argmax over k of corr(move[t], vix[t+k]); POSITIVE k ⇒ MOVE LEADS
 *
 * ⚠ **DIRECTION IS `HIGH` ON BOTH SERIES** (a vol level fires when it RISES), the opposite of the
 * curve probes' `<`. Cuts are the shipped REGISTRY pairs — R6's MOVE pair ([USER]-ruled, read it in
 * `src/registry.ts`) and VIX's — each on its own series, so neither arm transplants the other's cut.
 *
 * ⚠ **These are the REGISTRY pairs, not R6's full production state.** R6 left `CALIB_MAP` 2026-08-30;
 * production now ORs the registry pair with `scoreMoveLevel`'s rolling-percentile + velocity legs, which
 * can light a day this probe scores GREEN. The production-faithful arm is `npm run probe:event-study -- --probe=rt`,
 * which runs `resolveCuts` + the 2-close fold; this probe answers the FACTOR question, not the
 * firing-rate one. States here are RAW — no `CONFIRM_CLOSES` fold — so marginal-day counts are an
 * UPPER BOUND on the confirmed ones.
 *
 * ⚠ **A shared-rarity control is mandatory, not decorative.** MOVE and VIX live on different
 * scales, so the raw co-firing counts mix "these two series move together" with "one cut is simply
 * rarer than the other". Every arm therefore also reports a QUANTILE-MATCHED row: VIX re-cut at
 * MOVE's own rarity. The match is guarded against the A/A collapse by comparing the VIX FIRING
 * VECTORS at the shipped vs matched cut — never the cut VALUES, which can differ while the firing
 * is identical — and THROWS when they are byte-identical (the same guard `probe-eurc-ust.ts` needed
 * at review).
 * CAN-FIRE DEMO (working tree, 2026-07-26, restored by re-typing): forcing `vixCutQ = vixCut` throws
 * "AMBER-or-worse rarity-matched arm collapsed to A/A … byte-identical … over all 5848 days" — the
 * guard is not vacuous by construction.
 *
 * OFFLINE by construction: the only I/O is `readFixture` over committed
 * `scripts/backtest/data/{move,vix}.csv` — the SAME inputs the `--probe=rt` / `--probe=vl`
 * event-study arms score, so the two instruments cannot disagree about the underlying series. No
 * feed call, no network, no DB, no store, no write.
 */
import { VELOCITY_WINDOW, type Observation } from "../src/domain-types.js";
import { R6 } from "../src/registry-fred.js";
import { readFixture } from "./backtest/drift-guard.js";
import { pct, pearson } from "./lib/stats.js";

/** Widest lead/lag scanned, in trading days: ±120 for 20d changes, ±250 (~1y) for levels. */
const LAG_DELTA = 120;
const LAG_LEVEL = 250;

/** Shipped registry pairs, each on its own series — DERIVED, never restated (`indicator-loop.md`
 *  §a retune is a ONE-place edit; these were hardcoded at 90/105 and survived the 2026-07-29
 *  retune, so the probe scored a retired cut). */
const MOVE_AMBER = R6.thresholds.amberLevel!;
const MOVE_RED = R6.thresholds.redLevel!;
const VIX_AMBER = 20;
const VIX_RED = 30;

/** Inner join N series on their shared dates, preserving ascending date order. */
function joinAll(series: Observation[][]): { dates: string[]; values: number[][] } {
  const maps = series.map((s) => new Map(s.map((o) => [o.date, o.value])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, values: maps.map((m) => dates.map((d) => m.get(d)!)) };
}

/** Δ over `w` rows, aligned to `values[w..]` (the same convention as `velocityDelta`). */
function delta(values: number[], w: number): number[] {
  return values.slice(w).map((v, i) => v - values[i]!);
}

/**
 * argmax over k ∈ [−span, +span] of corr(a[t], b[t+k]). POSITIVE k ⇒ `a` LEADS `b`
 * (today's `a` lines up with `b` k days LATER); negative k ⇒ `b` leads `a`.
 */
function leadLag(a: number[], b: number[], span: number): { k: number; r: number } {
  let best = { k: 0, r: -2 };
  for (let k = -span; k <= span; k++) {
    const x = k >= 0 ? a.slice(0, a.length - k) : a.slice(-k);
    const y = k >= 0 ? b.slice(k) : b.slice(0, b.length + k);
    const r = pearson(x, y);
    if (r > best.r) best = { k, r };
  }
  return best;
}

/**
 * Share of `series` at or above `cut`. ⚠ `>=`, whereas the leg R6's registry pair actually scores
 * through is the CONVENTION leg (`evtLevel: false`), which `evaluateLegs` tests with a strict `>`.
 * Immaterial on this data — it can differ only on a close landing exactly on a cut — and the
 * production-faithful states are the `--probe=rt` event-study arm's, not this probe's.
 */
function rarityOf(series: number[], cut: number): number {
  return series.filter((v) => v >= cut).length / series.length;
}

/** Inverse of `rarityOf`: the value whose at-or-above share is ≈ `q` (nearest-rank, HIGH side). */
function valueAtRarity(series: number[], q: number): number {
  const sorted = [...series].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((1 - q) * sorted.length)));
  return sorted[idx]!;
}

/** One cut-level firing table: MOVE and VIX scored HIGH at `moveCut` / `vixCut`. */
function firingTable(label: string, move: number[], vix: number[], moveCut: number, vixCut: number, n: number): string {
  const mFires = move.map((v) => v >= moveCut);
  const vFires = vix.map((v) => v >= vixCut);
  const nM = mFires.filter(Boolean).length;
  const nV = vFires.filter(Boolean).length;
  const both = mFires.filter((v, i) => v && vFires[i]).length;
  const marginal = nM - both;
  const cond = both / Math.max(1, nM);
  return (
    `\n${label} (move ≥ ${moveCut}, vix ≥ ${vixCut.toFixed(4)}) over ${n} days:\n` +
    `  move fires        ${String(nM).padStart(5)} (${pct(nM / n)})\n` +
    `  vix fires         ${String(nV).padStart(5)} (${pct(nV / n)})   ← unconditional base rate\n` +
    `  BOTH              ${String(both).padStart(5)} (${pct(both / n)})\n` +
    `  move-only (M4)    ${String(marginal).padStart(5)} (${pct(marginal / n)})\n` +
    `  vix-only          ${String(nV - both).padStart(5)} (${pct((nV - both) / n)})\n` +
    `  P(vix | move)     ${cond.toFixed(3)}   lift ×${(cond / Math.max(1e-9, nV / n)).toFixed(2)}`
  );
}

async function main(): Promise<void> {
  const move = readFixture("scripts/backtest/data/move.csv");
  const vix = readFixture("scripts/backtest/data/vix.csv");
  for (const [name, s] of [
    ["move.csv", move],
    ["vix.csv", vix],
  ] as const) {
    console.log(
      `${name.padEnd(10)} ${String(s.length).padStart(6)} rows  ${s[0]!.date} → ${s.at(-1)!.date}  latest ${s.at(-1)!.value}`,
    );
  }

  const { dates, values } = joinAll([move, vix]);
  const n = dates.length;
  if (n < 1000) {
    throw new Error(
      `shared history is only ${n} days (expected ~5,900 — move.csv starts 2002-11) — the fixtures' ` +
        `date shapes have diverged, so every metric would be vacuous. Inspect the raw CSVs first.`,
    );
  }
  const m = values[0]!;
  const v = values[1]!;

  console.log(`\n${"═".repeat(72)}\nR6 MOVE  vs  R5 VIX   ${n} shared days  ${dates[0]} → ${dates.at(-1)}`);
  console.log(`\n  M1  level r   ${pearson(m, v).toFixed(4)}`);
  console.log(`  M2  Δ20 r     ${pearson(delta(m, VELOCITY_WINDOW), delta(v, VELOCITY_WINDOW)).toFixed(4)}   (same-factor line: 0.90)`);
  console.log(`      Δ1 r      ${pearson(delta(m, 1), delta(v, 1)).toFixed(4)}`);

  for (const [label, moveCut, vixCut] of [
    ["AMBER-or-worse", MOVE_AMBER, VIX_AMBER],
    ["RED", MOVE_RED, VIX_RED],
  ] as const) {
    console.log(firingTable(`${label} @ shipped registry cuts`, m, v, moveCut, vixCut, n));
    // Shared-rarity control: re-cut VIX at MOVE's OWN rarity, so the comparison is of the two
    // SERIES and not of two independently-chosen cut rarities. A/A GUARD: compare the two arms'
    // FIRING VECTORS, never their cut values — a matched cut landing in the same gap of the
    // empirical distribution fires byte-identically while a value test happily reports "not A/A".
    // Throw, don't skip: a control arm reproducing the treatment arm day-for-day is a broken
    // probe, not an omittable row.
    const qTarget = rarityOf(m, moveCut);
    const vixCutQ = valueAtRarity(v, qTarget);
    const qAchieved = rarityOf(v, vixCutQ);
    const shippedFires = v.map((x) => x >= vixCut);
    const matchedFires = v.map((x) => x >= vixCutQ);
    if (shippedFires.every((f, i) => f === matchedFires[i])) {
      throw new Error(
        `${label} rarity-matched arm collapsed to A/A: the VIX firing vector at the matched cut ` +
          `${vixCutQ} is byte-identical to the one at the shipped cut ${vixCut} over all ${n} days, ` +
          `so the shared-rarity control tests nothing. Inspect the VIX distribution around the cut ` +
          `before reading any marginal count.`,
      );
    }
    console.log(
      firingTable(`${label} @ rarity-matched VIX cut`, m, v, moveCut, vixCutQ, n) +
        `\n  matched cut       ${vixCutQ.toFixed(4)}   target rarity ${pct(qTarget)} (MOVE @ ${moveCut}) → achieved ${pct(qAchieved)} on VIX`,
    );
  }

  const llDelta = leadLag(delta(m, VELOCITY_WINDOW), delta(v, VELOCITY_WINDOW), LAG_DELTA);
  const llLevel = leadLag(m, v, LAG_LEVEL);
  console.log(`\nLEAD/LAG (positive k ⇒ MOVE LEADS VIX by k trading days):`);
  console.log(`  Δ20    k=${String(llDelta.k).padStart(4)}  r=${llDelta.r.toFixed(4)}`);
  console.log(`  level  k=${String(llLevel.k).padStart(4)}  r=${llLevel.r.toFixed(4)}`);
}

await main();
