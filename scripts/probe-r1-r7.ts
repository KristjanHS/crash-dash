/**
 * Read-only probe: are `R1` (10y−3m term spread, inversion) and `R7` (bull steepener, 2y-led) the
 * SAME event, or two states of one curve that arrive at different times? Written 2026-07-26 to adjudicate
 * `MEMBER_WEIGHT.R1` and `MEMBER_WEIGHT.R7` (`src/danger-ladder.ts`) — today BYTE-IDENTICAL rows
 * (`Semis 1.0 · S&P IT 0.8 · EM 1.0 · Value 0.6 · S&P 500 0.6 · ex-US 0.6 · EU-Fin 0.4 ·
 * Health 0.4 · Staples 0.4`), an assertion that inversion and bull-steepener hit every one of the
 * nine legs identically. Nothing measured that; it was never written down as a derivation.
 *
 *   npm run probe:r1-r7        # offline, reads committed fixtures, writes NOTHING
 *
 * ⚠ **THE RUNG-1/RUNG-2 METRIC SHAPE DOES NOT TRANSFER, and pretending it does would be the
 * defect.** EURC-vs-UST and MOVE-vs-VIX each compared two INDEPENDENT series, so "Δ20 r ≥ 0.90 ⇒
 * one factor" was the whole question. R1 and R7 are not two series: R7's own `series` field IS
 * `T10Y3M`, R1's series, and R7's state inputs (DGS2/DGS10) are R3's and R2's. They share a feed
 * set by construction. A series correlation between them therefore cannot discriminate — it is
 * near-tautological — so this probe reports the axis correlations only to SIZE that tautology, and
 * puts the load-bearing evidence in the CONFIRMED-STATE overlap, where the two rules actually differ:
 *
 *   A1  r(Δ20 T10Y3M, dSteepen)   the "one curve" size-check. T10Y3M's 20d change is Δ10y − Δ3m and
 *                                 R7's trigger axis is Δ10y − Δ2y, so these are the same difference
 *                                 taken against a 3m vs a 2y short leg. A HIGH r here is EXPECTED
 *                                 and is evidence about the curve, never about the two members.
 *   A2  r(T10Y3M level, d2y)      R1's axis is a LEVEL, R7's severity axis a 20d CHANGE — a low r is
 *   A3  r(Δ20 T10Y3M, d2y)        the null shape here, not a finding. Printed to keep rung 1/2's
 *                                 numbers on one page, not to be read as a same-factor verdict.
 *   S   STATE OVERLAP             the discriminating measure: both members' PRODUCTION CONFIRMED
 *                                 states, day-joined. `P(R1 | R7)` vs R1's base rate and `P(R7 | R1)`
 *                                 vs R7's — plus the R1-RELATIVE marginal days each way, an upper
 *                                 BOUND on what the `max` fold consumes (`observedWeightedMax`,
 *                                 `danger-engine.ts`). That fold maxes `MEMBER_WEIGHT × SEV_NUM`, not
 *                                 state, over all 10 `FAMILY_MEMBERS.rt` members — so a member's cell
 *                                 binds when its WEIGHTED severity beats every other rt member's,
 *                                 which a two-member table cannot settle and which differs from a
 *                                 state comparison wherever the weights differ.
 *   LL  ONSET lead/lag            for every R7 firing RUN's first day, the signed trading-day
 *                                 distance to the nearest R1 firing day. This is the plan's
 *                                 "different lead times" claim, measured on state ENTRIES rather
 *                                 than on the correlated axes — and, like the overlap, reported
 *                                 against the SAME ±1/2/3y rotation placebo, because a lead/lag
 *                                 split conditioned on R1's 22.7% base rate is otherwise
 *                                 uncontrolled.
 *
 * ⚠ **BOTH ARMS ARE PRODUCTION-FAITHFUL AND CONFIRMED, unlike rung 1/2's raw-state probes.** R1
 * runs the real chain (`synthesizedCalib` → `resolveCuts` → `rawStateSeries` → the 2-close fold) via
 * `confirmedStateLabels`, so its `evtLevel: true` / `ownZ: true` calibrated legs are ORed with the
 * registry 0.5/0.0 pair exactly as prod does. R7 runs `bullSteepenerReadingSeries`, whose `.state`
 * is already folded (`buildReadings(confirm = true)`). Neither state rule is reimplemented here.
 *
 * ⚠ **The CONTROL is a PLACEBO, not a rarity match — deliberately.** R1 fires on a large share of
 * days and R7 on a small one, so a raw `P(R1 | R7)` mostly reports R1's base rate. The obvious fix,
 * re-cutting R1 at R7's rarity, is NOT available here: R1's production state ORs calibrated EVT/z
 * legs, so a re-cut clone would change the cut AND silently drop those legs — two moves at once, and
 * the resulting arm would no longer be the state the weight table is about. Instead the R7 firing
 * vector is ROTATED forward/back by whole years (`research-probes.md` §"A conditional-return claim
 * owes a PLACEBO arm"), preserving its count and clustering while destroying its dates. If the real
 * `P(R1 | R7)` does not clear the placebo band, the overlap is R1's base rate and nothing else.
 * The SAME rotation controls the ONSET lead/lag block (`onsetTable`) — its lag share, lead share and
 * median each print beside the band the rotated arms produce, with a per-row verdict.
 * A/A GUARD: a placebo arm whose R7 firing VECTOR reproduces the real one day-for-day tests nothing
 * and THROWS — never a silently-skipped row. ONE guard (`placeboArm`), shared by both tables.
 * CAN-FIRE DEMO (working tree, 2026-07-26, restored by re-typing): forcing `PLACEBO_SHIFTS` to
 * include `0` throws "placebo arm k=+0d collapsed to A/A … byte-identical … over all 11111 days" —
 * re-run after the guard moved into `placeboArm`, and again with the `onsetTable` call ordered FIRST,
 * which throws from `onsetTable`, proving the ONSET arms are guarded too and not just the overlap's.
 * The `LL` warnings are likewise non-vacuous: at `LAG_DELTA = 5` / `LL_R_FLOOR = 0` the line prints a
 * bare `k=0 r=0.0317` with no warning and no suppression.
 *
 * ⚠ **R7 is a `confirmer: true`** (registry): under the retired verdict engine it could only raise
 * severity once the RATE base was already elevated. `MEMBER_WEIGHT` sits in the danger engine, which
 * has NO such gate — the row applies whenever R7's state is the family max — so a high `P(R1 | R7)`
 * does NOT make the row inert. It makes it redundant, which is a different (and cheaper) finding.
 *
 * OFFLINE by construction: the only I/O is `readFixture` over committed
 * `scripts/backtest/data/{t10y3m,dgs2,dgs10}.csv` — the same inputs the `--probe=rt` event-study
 * arms score, so the two instruments cannot disagree about the underlying series. No feed call, no
 * network, no DB, no store, no write.
 */
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { R7 } from "../src/registry-composite.js";
import { bullSteepenerReadingSeries } from "../src/scorers-composite.js";
import { confirmedStateLabels } from "./backtest/event-study.js";
import { readFixture } from "./backtest/drift-guard.js";
import { median, pct, pearson } from "./lib/stats.js";

/** Widest lead/lag scanned on the continuous axes, in trading days. */
const LAG_DELTA = 120;

/** Below this |r| the lead/lag argmax is a noise peak and its `k` is suppressed rather than printed. */
const LL_R_FLOOR = 0.1;

/**
 * Placebo shifts in TRADING days (±1y/±2y/±3y at 250/yr) — the same offsets the event-study
 * harness uses (`PLACEBO_OFFSET_YEARS` × `OBS_PER_YEAR.daily`), restated here rather than imported
 * so a harness edit cannot silently move this probe's control arm.
 */
const PLACEBO_SHIFTS = [250, 500, 750, -250, -500, -750] as const;

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

/** Circular shift by `k` positions: `out[i] = fires[(i - k + n) % n]`. Count and clustering survive. */
function rotateBy(fires: readonly boolean[], k: number): boolean[] {
  const n = fires.length;
  return fires.map((_, i) => fires[(((i - k) % n) + n) % n]!);
}

/**
 * `rotateBy` + THE A/A guard — the single guard for every placebo arm in this probe (overlap AND
 * onset). A rotation that reproduces the real firing vector day-for-day tests nothing, so it throws
 * rather than printing a reassuring row.
 */
function placeboArm(label: string, fires: readonly boolean[], k: number): boolean[] {
  const rotated = rotateBy(fires, k);
  if (rotated.every((f, i) => f === fires[i])) {
    throw new Error(
      `${label}: placebo arm k=${k >= 0 ? "+" : ""}${k}d collapsed to A/A — the rotated R7 firing ` +
        `vector is byte-identical to the real one over all ${fires.length} days, so the control tests ` +
        `nothing. Inspect the R7 firing pattern (an all-fire or no-fire vector is rotation-invariant) ` +
        `before reading any conditional.`,
    );
  }
  return rotated;
}

/**
 * A real statistic placed against its placebo arms. THREE-WAY by construction: a value BELOW every
 * arm is not "inside the band" — for the overlap it is the mutually-exclusive case, the strongest
 * two-different-events result there is — so it must never print the inside-the-band prose.
 */
function band(real: number, placebos: readonly number[]): { lo: number; hi: number; verdict: string } {
  const lo = Math.min(...placebos);
  const hi = Math.max(...placebos);
  return { lo, hi, verdict: real > hi ? "CLEARS" : real < lo ? "falls BELOW" : "is INSIDE" };
}

interface Overlap {
  nA: number;
  nB: number;
  both: number;
  pAgivenB: number;
  liftAgivenB: number;
  pBgivenA: number;
  liftBgivenA: number;
}

/** Co-firing arithmetic for two aligned boolean vectors. `a` = R1, `b` = R7. */
function overlap(a: readonly boolean[], b: readonly boolean[]): Overlap {
  const n = a.length;
  const nA = a.filter(Boolean).length;
  const nB = b.filter(Boolean).length;
  const both = a.filter((v, i) => v && b[i]).length;
  const pAgivenB = both / Math.max(1, nB);
  const pBgivenA = both / Math.max(1, nA);
  return {
    nA,
    nB,
    both,
    pAgivenB,
    liftAgivenB: pAgivenB / Math.max(1e-9, nA / n),
    pBgivenA,
    liftBgivenA: pBgivenA / Math.max(1e-9, nB / n),
  };
}

/** One severity level's state-overlap table + its placebo band. */
function overlapTable(label: string, r1Fires: boolean[], r7Fires: boolean[], n: number): string {
  const o = overlap(r1Fires, r7Fires);
  const out = [
    `\n${label} — CONFIRMED states over ${n} shared days:`,
    `  R1 fires          ${String(o.nA).padStart(5)} (${pct(o.nA / n)})   ← unconditional base rate`,
    `  R7 fires          ${String(o.nB).padStart(5)} (${pct(o.nB / n)})   ← unconditional base rate`,
    `  BOTH              ${String(o.both).padStart(5)} (${pct(o.both / n)})`,
    `  R7-only           ${String(o.nB - o.both).padStart(5)} (${pct((o.nB - o.both) / n)})   ← R1-relative marginal days (a BOUND on what the max fold consumes; rt has 10 members)`,
    `  R1-only           ${String(o.nA - o.both).padStart(5)} (${pct((o.nA - o.both) / n)})`,
    `  P(R1 | R7)        ${o.pAgivenB.toFixed(3)}   lift ×${o.liftAgivenB.toFixed(2)}`,
    `  P(R7 | R1)        ${o.pBgivenA.toFixed(3)}   lift ×${o.liftBgivenA.toFixed(2)}`,
  ];

  // PLACEBO control: same R7 firing count and run structure, wrong dates. The real P(R1 | R7) is
  // evidence of a shared event only insofar as it clears this band; inside it, the overlap is R1's
  // base rate arriving on schedule; BELOW it the two members would be firing on mutually exclusive
  // days. A/A guard lives in `placeboArm`.
  const placebos = PLACEBO_SHIFTS.map((k) => overlap(r1Fires, placeboArm(label, r7Fires, k)).pAgivenB);
  const b = band(o.pAgivenB, placebos);
  const tail =
    b.verdict === "CLEARS"
      ? " ⇒ more co-firing than chance"
      : b.verdict === "falls BELOW"
        ? " ⇒ the two members fire on MUTUALLY EXCLUSIVE days — a two-different-events result STRONGER than the null"
        : " ⇒ the overlap is R1's base rate, not a shared event";
  out.push(
    `  placebo P(R1|R7)  ${b.lo.toFixed(3)} … ${b.hi.toFixed(3)}   (${PLACEBO_SHIFTS.length} arms, R7 rotated ±1/2/3y)`,
    `  VERDICT           real ${o.pAgivenB.toFixed(3)} ${b.verdict} the placebo band${tail}`,
  );
  return out.join("\n");
}

/**
 * For every R7 firing RUN's first day, the signed trading-day distance to the nearest R1 firing day
 * (NEGATIVE ⇒ R1 was already firing before / fires earlier, i.e. R7 LAGS; POSITIVE ⇒ R7 leads).
 * Runs, not days, so one long episode counts once — the same rising-edge convention as
 * `bucketEpisodes` in the event-study harness.
 */
function onsetOffsets(r1Fires: readonly boolean[], r7Fires: readonly boolean[]): number[] {
  const r1Idx = r1Fires.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  if (r1Idx.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < r7Fires.length; i++) {
    if (!r7Fires[i] || (i > 0 && r7Fires[i - 1])) continue; // rising edges only
    let best = r1Idx[0]!;
    for (const j of r1Idx) if (Math.abs(j - i) < Math.abs(best - i)) best = j;
    out.push(best - i); // >0 ⇒ the nearest R1 firing day comes LATER ⇒ R7 leads
  }
  return out;
}

/** Lead / same-day / lag split + median of one onset-offset vector. */
function onsetSplit(offsets: readonly number[]): { lead: number; same: number; lag: number; n: number; med: number } {
  return {
    lead: offsets.filter((o) => o > 0).length,
    same: offsets.filter((o) => o === 0).length,
    lag: offsets.filter((o) => o < 0).length,
    n: offsets.length,
    med: median(offsets),
  };
}

/**
 * The ONSET lead/lag block WITH the same ±1/2/3y rotation control the overlap table uses. A raw
 * lead/lag split is a CONDITIONAL statistic — "how far is the nearest R1 firing day" is dominated by
 * R1's 22.7% base rate, which alone puts an R1 day within a few days of ANY date — so an uncontrolled
 * split is not evidence of sequencing (`research-probes.md` §"A conditional-return claim owes a
 * PLACEBO arm"). Lag share, lead share and the median each get their own band and verdict; only a row
 * OUTSIDE its band says anything about R7 vs R1.
 */
function onsetTable(label: string, r1Fires: readonly boolean[], r7Fires: readonly boolean[]): string {
  const real = onsetSplit(onsetOffsets(r1Fires, r7Fires));
  const arms = PLACEBO_SHIFTS.map((k) => onsetSplit(onsetOffsets(r1Fires, placeboArm(label, r7Fires, k))));
  const lagB = band(real.lag / Math.max(1, real.n), arms.map((a) => a.lag / Math.max(1, a.n)));
  const leadB = band(real.lead / Math.max(1, real.n), arms.map((a) => a.lead / Math.max(1, a.n)));
  const medB = band(real.med, arms.map((a) => a.med));
  const note = (v: string): string => (v === "is INSIDE" ? "   ⇒ NOT evidence — the placebo reproduces it" : "");
  return [
    `  ONSET lead/lag    ${real.n} R7 runs; ${real.lead} lead · ${real.same} same-day · ${real.lag} lag; ` +
      `median ${real.med.toFixed(1)}d (positive ⇒ R7 LEADS)`,
    `    lag share       real ${(real.lag / Math.max(1, real.n)).toFixed(3)}   placebo ${lagB.lo.toFixed(3)} … ${lagB.hi.toFixed(3)}   ` +
      `VERDICT ${lagB.verdict} the band${note(lagB.verdict)}`,
    `    lead share      real ${(real.lead / Math.max(1, real.n)).toFixed(3)}   placebo ${leadB.lo.toFixed(3)} … ${leadB.hi.toFixed(3)}   ` +
      `VERDICT ${leadB.verdict} the band${note(leadB.verdict)}`,
    `    median (days)   real ${real.med.toFixed(1)}   placebo ${medB.lo.toFixed(1)} … ${medB.hi.toFixed(1)}   ` +
      `VERDICT ${medB.verdict} the band${note(medB.verdict)}`,
    `                    (${PLACEBO_SHIFTS.length} arms, R7 rotated ±1/2/3y — same count and run structure, wrong dates)`,
  ].join("\n");
}

function main(): void {
  const spread = readFixture("scripts/backtest/data/t10y3m.csv");
  const dgs2 = readFixture("scripts/backtest/data/dgs2.csv");
  const dgs10 = readFixture("scripts/backtest/data/dgs10.csv");
  for (const [name, s] of [
    ["t10y3m.csv", spread],
    ["dgs2.csv", dgs2],
    ["dgs10.csv", dgs10],
  ] as const) {
    console.log(
      `${name.padEnd(12)} ${String(s.length).padStart(6)} rows  ${s[0]!.date} → ${s.at(-1)!.date}  latest ${s.at(-1)!.value}`,
    );
  }

  const R1 = ALL_INDICATORS.find((i) => i.id === "R1");
  if (!R1) throw new Error("[probe-r1-r7] R1 not in ALL_INDICATORS");

  // Both members through their PRODUCTION chains; joined on date, never on index — the two
  // series start at different offsets (R1 at `spread[VELOCITY_WINDOW..]`, R7 at the 3-way join).
  const r1States = new Map(confirmedStateLabels(R1, "scripts/backtest/data/t10y3m.csv").map((p) => [p.date, p.bucket]));
  const r7States = new Map(bullSteepenerReadingSeries(R7, spread, dgs2, dgs10).map((r) => [r.date, r.state]));
  const dates = [...r1States.keys()].filter((d) => r7States.has(d)).sort();
  const n = dates.length;
  if (n < 1000) {
    throw new Error(
      `shared history is only ${n} days (expected ~11,100 — t10y3m.csv from 1982-01 is the binding leg) ` +
        `— the fixtures' date shapes have diverged, so every metric would be vacuous. Inspect the raw CSVs first.`,
    );
  }

  console.log(`\n${"═".repeat(72)}\nR1 (10y−3m inversion)  vs  R7 (bull steepener, 2y-led)   ${n} shared days  ${dates[0]} → ${dates.at(-1)}`);

  // --- axis correlations (context, NOT the verdict — see the docblock) ---
  const byDate = (obs: typeof spread): Map<string, number> => new Map(obs.map((o) => [o.date, o.value]));
  const sp = byDate(spread);
  const g2 = byDate(dgs2);
  const g10 = byDate(dgs10);
  const axDates = dates.filter((d) => sp.has(d) && g2.has(d) && g10.has(d));
  const spV = axDates.map((d) => sp.get(d)!);
  const g2V = axDates.map((d) => g2.get(d)!);
  const g10V = axDates.map((d) => g10.get(d)!);
  const dSpread = delta(spV, VELOCITY_WINDOW);
  const d2y = delta(g2V, VELOCITY_WINDOW);
  const d10y = delta(g10V, VELOCITY_WINDOW);
  const dSteepen = d10y.map((v, i) => v - d2y[i]!);
  console.log(`\nAXIS CORRELATIONS over ${axDates.length} days — context for the state table, never a same-factor verdict:`);
  console.log(`  A1  r(Δ20 T10Y3M, dSteepen)   ${pearson(dSpread, dSteepen).toFixed(4)}   ← ONE CURVE: Δ10y−Δ3m vs Δ10y−Δ2y`);
  console.log(`  A2  r(T10Y3M level, d2y)      ${pearson(spV.slice(VELOCITY_WINDOW), d2y).toFixed(4)}   ← level vs change: a low r is the null shape`);
  console.log(`  A3  r(Δ20 T10Y3M, d2y)        ${pearson(dSpread, d2y).toFixed(4)}`);
  const ll = leadLag(d2y, spV.slice(VELOCITY_WINDOW), LAG_DELTA);
  // An argmax is only a lead/lag reading when it is INTERIOR to the scan and rides a real
  // correlation. Pinned to the ±LAG_DELTA rail ⇒ the true max is outside the window and the printed
  // k is the rail, not a lag; |r| under the floor ⇒ the peak is noise on ~11k days and the k is
  // meaningless whatever its position. Either way the k is SUPPRESSED, so the line can never be read
  // as "the 2y leads T10Y3M by LAG_DELTA days".
  const railPinned = Math.abs(ll.k) === LAG_DELTA;
  const belowFloor = Math.abs(ll.r) < LL_R_FLOOR;
  const warn =
    (railPinned ? `  ⚠ argmax PINNED to the ±${LAG_DELTA}d scan rail — the true max lies OUTSIDE the window` : "") +
    (belowFloor ? `  ⚠ |r| < ${LL_R_FLOOR.toFixed(2)} floor — a noise peak, not a lead/lag` : "");
  const kShown = railPinned || belowFloor ? "  n/a" : String(ll.k).padStart(4);
  console.log(
    `  LL  d2y leads T10Y3M level    k=${kShown}  r=${ll.r.toFixed(4)}   (positive k ⇒ the 2y move comes FIRST)` +
      `${warn}${warn ? `  [argmax k=${ll.k} suppressed]` : ""}`,
  );

  // --- state overlap: the load-bearing measure ---
  for (const [label, fires] of [
    ["AMBER-or-worse", (s: string) => s === "AMBER" || s === "RED"],
    ["RED", (s: string) => s === "RED"],
  ] as const) {
    const r1F = dates.map((d) => fires(r1States.get(d)!));
    const r7F = dates.map((d) => fires(r7States.get(d)!));
    console.log(overlapTable(label, r1F, r7F, n));
    console.log(onsetTable(label, r1F, r7F));
  }
}

main();
