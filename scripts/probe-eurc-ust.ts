/**
 * Read-only probe: how much does the EURO curve (`EURC`, ECB SR_10Y − SR_3M) tell you about the
 * **US** curve? Written 2026-07-26 to adjudicate
 * `MEMBER_WEIGHT.EURC`'s zeros on `S&P IT`, `S&P 500` and `EM`
 * (`src/danger-ladder.ts`). Those zeros shipped on the stated ground that the euro curve is
 * "EU/DM-ex-US-scoped, US-only legs and EM get 0" —
 * an assertion, never measured. `probe:bund-ust` refuted the same claim for the row BUND
 * *copied* from this one, so EURC owes its own arm rather than inheriting that verdict.
 *
 *   npm run probe:eurc-ust        # network only, writes NOTHING (no store handle at all)
 *
 * Metric shapes are `probe-bund-ust.ts`'s, unchanged, so the two runs are directly comparable:
 *
 *   M1  Pearson r of daily LEVELS
 *   M2  Pearson r of 20d CHANGES (dynamics/timing, not the shared trend)
 *   Δ1  Pearson r of 1d CHANGES — the shortest-horizon co-movement, printed beside M2 so a Δ20
 *       reading can be told from same-day mechanical co-movement
 *   M4  MARGINAL firing days — EURC AMBER-or-worse while the US curve does NOT fire at the cut in
 *       force for that row (see the per-arm qualification below: "GREEN" is exact only on T10Y3M)
 *   LL  lead/lag — argmax over k of corr(eurc[t], us[t+k]); POSITIVE k ⇒ EURC LEADS
 *
 * TWO US comparators, because the tenor match matters here in a way it did not for BUND:
 *   • `T10Y3M` — the SAME 10y−3m tenor pair EURC is built from, and R1's own series. This is the
 *     like-for-like arm; a high r here is the strongest possible case that EURC is an echo.
 *   • `T10Y2Y` — the arm `probe:bund-ust` used, kept so EURC's numbers sit on the same axis as
 *     BUND's recorded 0.774 / 0.573.
 *
 * ⚠ **The "cuts are EURC-calibrated" caveat binds the T10Y2Y arm ONLY.** `EURC_AMBER`/`EURC_RED`
 * are 0.5 / 0.0, which are NUMERICALLY the same values as R1's own registry thresholds
 * (`amberLevel: 0.5`, `redLevel: 0.0` on series `T10Y3M`, `src/registry.ts`) — so on the T10Y3M arm
 * this probe is not transplanting a foreign cut at all: it computes exactly R1's production states,
 * and "the US curve is GREEN" in that arm's M4 row is literally R1 GREEN. On the T10Y2Y arm the
 * same numbers ARE a transplant (no production indicator scores T10Y2Y at 0.5/0.0), so base rates
 * there are not like-for-like and the load-bearing output is the CONDITIONAL lift
 * `P(us fires | eurc fires)` vs the US unconditional rate, printed side by side — never the raw
 * counts on their own.
 *
 * ⚠ **A shared cut across two tenors manufactures one-directional firing.** A 10y−2y spread sits
 * structurally below a 10y−3m one on an upward-sloping curve, so the T10Y2Y arm additionally
 * reports a QUANTILE-MATCHED row: the US series re-cut at its own equally-rare value. If the
 * marginal count survives that, it is signal; if it collapses, the asymmetry was the offset.
 * (Same falsifier shape as `probe-bund-eurc.ts` §7a.) The matched row is guarded against the A/A
 * collapse by comparing the US FIRING VECTORS at the shared vs matched cut — never the cut VALUES,
 * which can differ while the firing is identical — and THROWS when they are byte-identical.
 *
 * ⚠ **States here are RAW, not CONFIRMED** — production folds each raw state through the
 * `CONFIRM_CLOSES` buffer first, which deletes 1-day flickers, so raw marginal-day counts are an
 * UPPER BOUND on the confirmed ones.
 *
 * ⚠ ECB SDMX and FRED are joined by DATE STRING. If either feed's date shape changed the inner
 * join would go silently empty and every metric would be vacuously computed over nothing — so a
 * thin join throws rather than printing a confident table.
 */
import { fetchEcbSeries } from "../src/ecb.js";
import { realFeeds } from "../src/feed-ports.js";
import { EURC_AMBER, EURC_RED } from "../src/family-descriptor-rows.js";
import { VELOCITY_WINDOW, type Observation } from "../src/domain-types.js";
import { pct, pearson } from "./lib/stats.js";
import { readEnv } from "../src/config.js";

/** Widest lead/lag scanned, in trading days: ±120 for 20d changes, ±250 (~1y) for levels. */
const LAG_DELTA = 120;
const LAG_LEVEL = 250;

/** ECB SDMX needs an explicit start; 2004 is where SR_3M's daily history is dense. */
const SHARED_START = "2004-01-01";

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

/** Share of `series` strictly below `cut` — matching `ratioSpreadState`'s spread `<`. */
function quantileOf(series: number[], cut: number): number {
  return series.filter((v) => v < cut).length / series.length;
}

/** Inverse of `quantileOf`: the value whose strictly-below share is ≈ `q` (nearest-rank). */
function valueAtQuantile(series: number[], q: number): number {
  const sorted = [...series].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * sorted.length)));
  return sorted[idx]!;
}

/** One cut-level firing table: EURC and the US arm scored at `eurcCut` / `usCut`. */
function firingTable(
  label: string,
  eurc: number[],
  us: number[],
  eurcCut: number,
  usCut: number,
  n: number,
): string {
  const eFires = eurc.map((v) => v < eurcCut);
  const uFires = us.map((v) => v < usCut);
  const nE = eFires.filter(Boolean).length;
  const nU = uFires.filter(Boolean).length;
  const both = eFires.filter((v, i) => v && uFires[i]).length;
  const marginal = nE - both;
  const cond = both / Math.max(1, nE);
  return (
    `\n${label} (eurc < ${eurcCut}, us < ${usCut.toFixed(4)}) over ${n} days:\n` +
    `  eurc fires        ${String(nE).padStart(5)} (${pct(nE / n)})\n` +
    `  us fires          ${String(nU).padStart(5)} (${pct(nU / n)})   ← unconditional base rate\n` +
    `  BOTH              ${String(both).padStart(5)} (${pct(both / n)})\n` +
    `  eurc-only (M4)    ${String(marginal).padStart(5)} (${pct(marginal / n)})\n` +
    `  us-only           ${String(nU - both).padStart(5)} (${pct((nU - both) / n)})\n` +
    `  P(us | eurc)      ${cond.toFixed(3)}   lift ×${(cond / Math.max(1e-9, nU / n)).toFixed(2)}`
  );
}

/** Run every metric for ONE US comparator against the euro spread. */
function arm(name: string, eurc: number[], us: number[], dates: string[], quantileMatch: boolean): void {
  const n = dates.length;
  console.log(`\n${"═".repeat(72)}\nEURC (SR_10Y − SR_3M)  vs  FRED ${name}   ${n} shared days  ${dates[0]} → ${dates.at(-1)}`);
  console.log(`\n  M1  level r   ${pearson(eurc, us).toFixed(4)}`);
  console.log(`  M2  Δ20 r     ${pearson(delta(eurc, VELOCITY_WINDOW), delta(us, VELOCITY_WINDOW)).toFixed(4)}   (same-factor line: 0.90)`);
  console.log(`      Δ1 r      ${pearson(delta(eurc, 1), delta(us, 1)).toFixed(4)}`);

  for (const [label, cut] of [
    ["AMBER-or-worse", EURC_AMBER],
    ["RED", EURC_RED],
  ] as const) {
    console.log(firingTable(`${label} @ EURC cut`, eurc, us, cut, cut, n));
    if (quantileMatch) {
      // Offset falsifier: re-cut the US series at ITS OWN equally-rare value, so the comparison is
      // of the series and not of a tenor-driven level offset. A/A GUARD: compare the two arms'
      // FIRING VECTORS, never their cut VALUES. A `|usCutQ − cut| < 1e-9` test is the wrong
      // instrument in both directions — FRED publishes these spreads to 2 decimals, so two cuts
      // 0.001 apart land in the same gap of the empirical distribution and fire byte-identically
      // while the value test happily reports "not A/A" (demonstrated 2026-07-26: forcing
      // `usCutQ = cut − 0.001` reproduces the shared-cut vector over all 5,406 days). Throw, don't
      // skip: a control arm that reproduces the treatment arm day-for-day is a broken probe, not an
      // omittable row.
      const qTarget = quantileOf(eurc, cut);
      const usCutQ = valueAtQuantile(us, qTarget);
      const qAchieved = quantileOf(us, usCutQ);
      const sharedFires = us.map((v) => v < cut);
      const matchedFires = us.map((v) => v < usCutQ);
      if (sharedFires.every((f, i) => f === matchedFires[i])) {
        throw new Error(
          `${label} quantile-matched arm collapsed to A/A on ${name}: the US firing vector at the ` +
            `matched cut ${usCutQ} is byte-identical to the one at the shared cut ${cut} over all ` +
            `${n} days, so the offset falsifier tests nothing. Inspect the US distribution around ` +
            `the cut before reading any marginal count.`,
        );
      }
      console.log(
        firingTable(`${label} @ quantile-matched US cut`, eurc, us, cut, usCutQ, n) +
          `\n  matched cut       ${usCutQ.toFixed(4)}   target q ${pct(qTarget)} (EURC @ ${cut}) → achieved q ${pct(qAchieved)} on ${name}`,
      );
    }
  }

  const llDelta = leadLag(delta(eurc, VELOCITY_WINDOW), delta(us, VELOCITY_WINDOW), LAG_DELTA);
  const llLevel = leadLag(eurc, us, LAG_LEVEL);
  console.log(`\nLEAD/LAG (positive k ⇒ EURC LEADS ${name} by k trading days):`);
  console.log(`  Δ20    k=${String(llDelta.k).padStart(4)}  r=${llDelta.r.toFixed(4)}`);
  console.log(`  level  k=${String(llLevel.k).padStart(4)}  r=${llLevel.r.toFixed(4)}`);
}

async function main(): Promise<void> {
  const env = readEnv();
  const [sr10y, sr3m, t10y3m, t10y2y] = await Promise.all([
    fetchEcbSeries("SR_10Y", { startPeriod: SHARED_START }),
    fetchEcbSeries("SR_3M", { startPeriod: SHARED_START }),
    realFeeds.fetchSeries("T10Y3M", { fullHistory: true, now: new Date(), env }),
    realFeeds.fetchSeries("T10Y2Y", { fullHistory: true, now: new Date(), env }),
  ]);
  for (const [name, s] of [
    ["ecb SR_10Y", sr10y],
    ["ecb SR_3M", sr3m],
    ["fred T10Y3M", t10y3m],
    ["fred T10Y2Y", t10y2y],
  ] as const) {
    console.log(
      `${name.padEnd(12)} ${String(s.length).padStart(6)} rows  ${s[0]!.date} → ${s.at(-1)!.date}  latest ${s.at(-1)!.value}`,
    );
  }

  // Each arm is joined on ITS OWN pair of feeds — a single 4-way join would silently shrink both
  // arms to the intersection and make the T10Y3M numbers non-comparable with probe:bund-ust's.
  for (const [name, series, matchQuantiles] of [
    ["T10Y3M", t10y3m, false],
    ["T10Y2Y", t10y2y, true],
  ] as const) {
    const { dates, values } = joinAll([sr10y, sr3m, series]);
    if (dates.length < 1000) {
      throw new Error(
        `shared history with ${name} is only ${dates.length} days (expected ~5,000) — the SDMX/FRED ` +
          `date formats have diverged, so every metric would be vacuous. Inspect the raw responses first.`,
      );
    }
    const eurc = values[0]!.map((x, i) => x - values[1]![i]!);
    arm(name, eurc, values[2]!, dates, matchQuantiles);
  }
}

await main();
