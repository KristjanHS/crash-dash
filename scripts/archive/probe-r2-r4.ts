/**
 * Read-only probe: are `R2` (DGS10, 10y NOMINAL yield, Δ20 velocity, amber +0.40 / red +0.70) and
 * `R4` (DFII10, 10y REAL yield, Δ20 velocity, amber +0.18 / red +0.25) ONE factor? Written
 * 2026-07-26 to adjudicate
 * `MEMBER_WEIGHT.R2` and `MEMBER_WEIGHT.R4` (`src/danger-ladder.ts`). ⚠ THE ROW SHAPES
 * HAVE MOVED TWICE since this probe was written — do not read the 2026-07-26 numbers as measured
 * against today's rows. ⚠ DO NOT RE-TYPE AN ENUMERATION HERE: a hand-typed copy of these rows has
 * been wrong TWICE; read `MEMBER_WEIGHT.R2`/`.R4` in `src/danger-ladder.ts` for the live cells. As of
 * the 2026-08-04 retune the two rows agree on eight legs and differ only on `Semis`, with the
 * divergence the OTHER WAY ROUND from the original (R4 above R2).
 * Trail: `Semis` diverged R2 1.0 / R4 0.6 until 2026-08-03, when §11.3 item C shape-matched R2
 * DOWN to 0.6 and the rows became cell-for-cell equal; on 2026-08-04
 * a ruling restored R4 to 1.0 on the duration axis (leaving R2 at the
 * demoted 0.6) and cut `EU-Fin`/`Staples` to 0.4 on both. The plan's rule: if Δ20 `r` ≥ 0.90 they are
 * one factor and one row is ceremony under the `rt` family's max fold.
 * ⚠ The A/A hazard recorded while the rows were EQUAL is LIFTED — the arms can separate again — but
 * §11.3's waiver of the re-run stands; do not schedule it on the strength of that alone.
 *
 *   npm run probe:r2-r4        # offline, reads committed fixtures, writes NOTHING
 *
 * ⚠ **THE Δ20 CORRELATION HERE IS PARTLY MECHANICAL, AND HIDING THAT WOULD BE THE DEFECT.** Unlike
 * rung 1 (EURC vs UST) and rung 2 (MOVE vs VIX), whose two series are only economically related,
 * these two are related by an IDENTITY: the 10y nominal yield IS the 10y real yield plus 10y
 * breakeven inflation, so
 *
 *     Δ20 DGS10  ≡  Δ20 DFII10  +  Δ20 breakeven
 *
 * and R2's axis literally CONTAINS R4's. A high `r` is therefore expected before any economics is
 * done, exactly as rung 3's A1 arm was near-tautological (R7's `series` IS R1's). The probe follows
 * rung 3's convention — print the number only to SIZE the tautology, never to settle the question —
 * and the `CONFOUND` block decomposes it:
 *
 *     r(Δn, Δr)  =  σr/σn  +  cov(Δb, Δr)/(σn·σr)
 *                   ╰──┬──╯    ╰────────┬────────╯
 *          IDENTITY-ONLY BASELINE   the only economic part: the r that would remain if the
 *          (the ORTHOGONAL-CASE r:   breakeven leg moved independently of the real leg
 *           what the identity alone
 *           produces when Δb ⊥ Δr)
 *
 * so the axis verdict is read against that baseline, not against zero. A measured `r` at or near it
 * means "the identity, and nothing else"; the 0.90 line is applied to the raw `r` because that is
 * what the plan wrote, but the baseline is printed beside it so the raw number can never be quoted
 * alone. ⚠ IT IS NOT A FLOOR — it was called one until review (2026-07-26), and the measurement
 * breaches it: the residual term is signed, so a NEGATIVE breakeven/real covariance puts the
 * measured `r` BELOW σr/σn. A quantity the data goes under is a baseline, not a bound.
 *
 * The LOAD-BEARING evidence is the CONFIRMED-STATE overlap, where the two members can differ — and
 * they differ by CALIBRATION, not by axis size: measured, σ(Δ20 nominal) is only 1.14× σ(Δ20 real)
 * (0.2482 vs 0.2181), while R2's convention cuts are 2.2× R4's (0.40/0.70 vs 0.18/0.25). So R4 is
 * cut FAR tighter on a barely-smaller axis, and "same axis" does NOT imply "same firing days"; it
 * implies the opposite here, with R4 firing on ~3× as many days.
 *
 * ⚠ **BOTH ARMS RUN THE PRODUCTION CHAIN.** Each member goes through `confirmedStateLabels`
 * (`synthesizedCalib` → `resolveCuts` → `rawStateSeries` → the 2-close fold), so R4's EVT / regime-z
 * legs are ORed with its registry 0.18/0.25 convention pair exactly as prod does. No threshold is
 * re-implemented here.
 *
 * ⚠ **The CONTROL is a PLACEBO, not a rarity match** (`research-probes.md` §"A conditional-return
 * claim owes a PLACEBO arm"), and the CONDITIONER is what gets rotated: `P(R4 | R2)` is banded by
 * rotating R2, `P(R2 | R4)` by rotating R4, forward/back by whole years — count and clustering
 * preserved, dates destroyed. A lift INSIDE its placebo band is NOT evidence of a shared event; it
 * is the other member's base rate arriving on schedule, and the output says so per row.
 * A/A GUARD: any rotation reproducing the real firing vector day-for-day THROWS (`placeboArm`).
 * CAN-FIRE DEMO (working tree, 2026-07-26, both restored by re-typing): adding `0` to
 * `PLACEBO_SHIFTS` throws "AMBER-or-worse P(R4|R2): placebo arm k=+0d collapsed to A/A — … byte-
 * identical … over all 5863 days" from the FIRST table, proving the guard runs before any
 * conditional prints; and truncating the joined `dates` to 500 rows throws the `n < 1000`
 * shared-history guard ("shared history is only 500 days (expected ~5,850 …)").
 *
 * ⚠ **THE STRICT-ARGMAX ARM (`argmaxTable`) MEASURES WHAT THE OVERLAP TABLE ONLY BOUNDS.** A
 * marginal-day count says how often one member fires alone; it does NOT say whether that member's
 * cell ever BINDS, because `observedWeightedMax` (`danger-engine.ts`) folds `MEMBER_WEIGHT × SEV_NUM`
 * over every observed relevant `FAMILY_MEMBERS.rt` member, per leg, through `quasiMaxFold` — the max
 * term plus a breadth bonus on the mean of the rest. So the argmax arm re-scores the whole rt
 * field day-by-day and asks, per bucket, whether R2 (or R4) is the STRICT weighted-severity argmax on
 * ≥1 leg — the same check rung 3 ran for R7. Two things travel with every share it prints:
 *   • the field is INCOMPLETE (members without a committed fixture are absent — the run's `NOT in
 *     the field` line prints which), and more rivals can only lower a strict-argmax share ⇒ every
 *     share is an UPPER BOUND, so a LOW share is the strong result. An absentee with no
 *     `MEMBER_WEIGHT` row has `memberWeight` 0 on all nine legs and cannot tighten the bound;
 *   • the argmax share is the MAX TERM's binding share, NOT R2's whole contribution — under the
 *     quasi-max every relevant observed member also enters the breadth bonus (a GREEN one as a
 *     diluting 0), which is what the leave-one-out arm measures;
 *   • it carries NO placebo arm ON PURPOSE — it is a deterministic accounting of the fold over the
 *     same days, with no forward window and no return, so there is no conditional-return claim for a
 *     rotation to control (`research-probes.md`);
 *   • every share it prints is WITHIN-BUCKET, over buckets that are themselves rare, so the table now
 *     also prints the WHOLE-WINDOW denominator (review fix, 2026-07-26) — the two must be quoted
 *     together or the rare-bucket conditioning disappears.
 *
 * ⚠ **AND BINDING IS NOT IMPACT — `leaveOneOutTable` IS THE ARM THE DISPOSITION SHOULD LEAN ON.**
 * Being the strict argmax only says R2's cell is the one the max picks; it does not say the cell
 * would read differently without R2, because the runner-up can sit just below it inside the SAME
 * `SEV_CUTS` band. The leave-one-out arm re-scores the rt cell with and without R2 and separates the
 * two: how often R2 raises a leg's `wsev` at all, and how often that raise crosses a cut. Measured
 * 2026-07-26, the second number is HALF the first, and the split is not where the argmax histogram
 * suggests — see the arm's own docblock.
 * CAN-FIRE DEMO (working tree, 2026-07-26, both restored by re-typing): cutting `RT_FIXTURE` down to
 * R2/R4 throws "the rt argmax field has only 1 rival member(s) besides R2/R4 (R7)"; `.slice(0, 500)`
 * on the joined `dates` throws "the 6-member rt argmax window is only 500 days".
 *
 * OFFLINE by construction: the only I/O is `readFixture` over committed
 * `scripts/backtest/data/{dgs10,dfii10}.csv` — plus, for the argmax field, `{t10y3m,dgs2,move}.csv`.
 * No feed call, no network, no DB, no store, no write.
 */
import { FAMILY_MEMBERS, LEG_FIELD, MEMBER_WEIGHT, type LegKey } from "../src/danger-ladder.js";
import {
  BREADTH_LAMBDA,
  SEV_CUTS,
  memberScaledBand,
  quasiMaxFold,
  scaledSevBand,
  type Sev,
} from "../src/danger-engine.js";
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { R7 } from "../src/registry-composite.js";
import { bullSteepenerReadingSeries } from "../src/scorers-composite.js";
import { confirmedStateLabels } from "./backtest/event-study.js";
import { readFixture } from "./backtest/drift-guard.js";
import { mean, median, pct, pct2, pearson, sd } from "./lib/stats.js";

/** The plan's same-factor line (`probe-bund-eurc.ts` §3.2, restated by rung 4). */
const SAME_FACTOR_R = 0.9;

/** Widest lead/lag scanned on the continuous axes, in trading days. */
const LAG_DELTA = 120;

/** Below this |r| the lead/lag argmax is a noise peak and its `k` is suppressed rather than printed. */
const LL_R_FLOOR = 0.1;

/**
 * Placebo shifts in TRADING days (±1y/±2y/±3y at 250/yr) — the same offsets the event-study harness
 * uses (`PLACEBO_OFFSET_YEARS` × `OBS_PER_YEAR.daily`) and rung 3's `probe-r1-r7.ts` restated,
 * restated again here so a harness edit cannot silently move this probe's control arm.
 */
const PLACEBO_SHIFTS = [250, 500, 750, -250, -500, -750] as const;

function cov(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  return a.reduce((s, x, i) => s + (x - ma) * (b[i]! - mb), 0) / a.length;
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

// `pct`/`pct2` are `lib/stats.js`'s. Whole-window shares here run well under 1%, where one decimal
// rounds distinct counts onto the same printed number (72/5792 and 34/5792 both read "0.6%"/"1.2%"-ish)
// — hence `pct2` on those lines only.

/** Circular shift by `k` positions: `out[i] = fires[(i - k + n) % n]`. Count and clustering survive. */
function rotateBy(fires: readonly boolean[], k: number): boolean[] {
  const n = fires.length;
  return fires.map((_, i) => fires[(((i - k) % n) + n) % n]!);
}

/**
 * `rotateBy` + THE A/A guard — the single guard for every placebo arm in this probe. A rotation that
 * reproduces the real firing vector day-for-day tests nothing, so it throws rather than printing a
 * reassuring row.
 */
function placeboArm(label: string, fires: readonly boolean[], k: number): boolean[] {
  const rotated = rotateBy(fires, k);
  if (rotated.every((f, i) => f === fires[i])) {
    throw new Error(
      `${label}: placebo arm k=${k >= 0 ? "+" : ""}${k}d collapsed to A/A — the rotated conditioner's ` +
        `firing vector is byte-identical to the real one over all ${fires.length} days, so the control ` +
        `tests nothing. Inspect the firing pattern (an all-fire or no-fire vector is rotation-invariant) ` +
        `before reading any conditional.`,
    );
  }
  return rotated;
}

/**
 * A real statistic placed against its placebo arms. THREE-WAY by construction: a value BELOW every
 * arm is not "inside the band" — for a conditional it is the mutually-exclusive case, the strongest
 * two-different-events result there is — so it must never print the inside-the-band prose.
 */
function band(real: number, placebos: readonly number[]): { lo: number; hi: number; verdict: string } {
  const lo = Math.min(...placebos);
  const hi = Math.max(...placebos);
  return { lo, hi, verdict: real > hi ? "CLEARS" : real < lo ? "falls BELOW" : "is INSIDE" };
}

/** `P(target fires | conditioner fires)`, and its lift over the target's unconditional base rate. */
function conditional(target: readonly boolean[], conditioner: readonly boolean[]): { p: number; lift: number } {
  const n = target.length;
  const nC = conditioner.filter(Boolean).length;
  const both = conditioner.filter((v, i) => v && target[i]).length;
  const base = target.filter(Boolean).length / n;
  const p = both / Math.max(1, nC);
  return { p, lift: p / Math.max(1e-9, base) };
}

const bandTail = (verdict: string): string =>
  verdict === "CLEARS"
    ? " ⇒ more co-firing than chance"
    : verdict === "falls BELOW"
      ? " ⇒ MUTUALLY EXCLUSIVE days — a two-different-events result STRONGER than the null"
      : " ⇒ NOT evidence — the lift is the target's base rate, reproduced by the placebo";

/**
 * One severity level's state-overlap table. Both conditionals get their OWN placebo band, each
 * produced by rotating the CONDITIONER (the vector the probability conditions on), so neither
 * direction is banded by the other's control.
 */
function overlapTable(label: string, r2Fires: boolean[], r4Fires: boolean[], n: number): string {
  const n2 = r2Fires.filter(Boolean).length;
  const n4 = r4Fires.filter(Boolean).length;
  const both = r2Fires.filter((v, i) => v && r4Fires[i]).length;
  const c42 = conditional(r4Fires, r2Fires); // P(R4 | R2) — rotate R2
  const c24 = conditional(r2Fires, r4Fires); // P(R2 | R4) — rotate R4
  const b42 = band(
    c42.p,
    PLACEBO_SHIFTS.map((k) => conditional(r4Fires, placeboArm(`${label} P(R4|R2)`, r2Fires, k)).p),
  );
  const b24 = band(
    c24.p,
    PLACEBO_SHIFTS.map((k) => conditional(r2Fires, placeboArm(`${label} P(R2|R4)`, r4Fires, k)).p),
  );
  return [
    `\n${label} — CONFIRMED states over ${n} shared days:`,
    `  R2 fires          ${String(n2).padStart(5)} (${pct(n2 / n)})   ← unconditional base rate`,
    `  R4 fires          ${String(n4).padStart(5)} (${pct(n4 / n)})   ← unconditional base rate`,
    `  BOTH (co-firing)  ${String(both).padStart(5)} (${pct(both / n)})`,
    `  R4-only           ${String(n4 - both).padStart(5)} (${pct((n4 - both) / n)})   ← marginal days R2 NEVER sees`,
    `  R2-only           ${String(n2 - both).padStart(5)} (${pct((n2 - both) / n)})   ← marginal days R4 NEVER sees`,
    `                    (both counts BOUND where the fold's max term could bind — the rt field has other`,
    `                     members, so a marginal day binds it only where that member is also the weighted-severity argmax)`,
    `  P(R4 | R2)        ${c42.p.toFixed(3)}   lift ×${c42.lift.toFixed(2)}   placebo ${b42.lo.toFixed(3)} … ${b42.hi.toFixed(3)}`.padEnd(
      64,
    ) + `  (the two lifts are EQUAL by construction — both are joint/(base×base))`,
    `    VERDICT         real ${c42.p.toFixed(3)} ${b42.verdict} the band${bandTail(b42.verdict)}`,
    `  P(R2 | R4)        ${c24.p.toFixed(3)}   lift ×${c24.lift.toFixed(2)}   placebo ${b24.lo.toFixed(3)} … ${b24.hi.toFixed(3)}`,
    `    VERDICT         real ${c24.p.toFixed(3)} ${b24.verdict} the band${bandTail(b24.verdict)}`,
    `                    (${PLACEBO_SHIFTS.length} arms each, CONDITIONER rotated ±1/2/3y — same count and run structure, wrong dates)`,
  ].join("\n");
}

/**
 * For every firing RUN's first day in `bFires`, the signed trading-day distance to the nearest
 * `aFires` firing day (NEGATIVE ⇒ `a` fires earlier, i.e. `b` LAGS; POSITIVE ⇒ `b` leads). Runs, not
 * days, so one long episode counts once — the same rising-edge convention as `bucketEpisodes` in the
 * event-study harness.
 */
function onsetOffsets(aFires: readonly boolean[], bFires: readonly boolean[]): number[] {
  const aIdx = aFires.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  if (aIdx.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < bFires.length; i++) {
    if (!bFires[i] || (i > 0 && bFires[i - 1])) continue; // rising edges only
    let best = aIdx[0]!;
    for (const j of aIdx) if (Math.abs(j - i) < Math.abs(best - i)) best = j;
    out.push(best - i); // >0 ⇒ the nearest `a` firing day comes LATER ⇒ `b` leads
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
 * The ONSET lead/lag block WITH the same
 * ±1/2/3y rotation control. A raw lead/lag split is a CONDITIONAL statistic — "how far is the nearest R2
 * firing day" is dominated by R2's base rate, which alone puts an R2 day within a few days of ANY date — so
 * an uncontrolled split is not evidence of sequencing. Lag share, lead share and the median each get their
 * own band; only a row OUTSIDE its band says anything about R4 vs R2.
 */
function onsetTable(label: string, r2Fires: readonly boolean[], r4Fires: readonly boolean[]): string {
  const real = onsetSplit(onsetOffsets(r2Fires, r4Fires));
  const arms = PLACEBO_SHIFTS.map((k) => onsetSplit(onsetOffsets(r2Fires, placeboArm(`${label} ONSET`, r4Fires, k))));
  const lagB = band(
    real.lag / Math.max(1, real.n),
    arms.map((a) => a.lag / Math.max(1, a.n)),
  );
  const leadB = band(
    real.lead / Math.max(1, real.n),
    arms.map((a) => a.lead / Math.max(1, a.n)),
  );
  const medB = band(
    real.med,
    arms.map((a) => a.med),
  );
  const note = (v: string): string => (v === "is INSIDE" ? "   ⇒ NOT evidence — the placebo reproduces it" : "");
  return [
    `  ONSET lead/lag    ${real.n} R4 runs; ${real.lead} lead · ${real.same} same-day · ${real.lag} lag; ` +
      `median ${real.med.toFixed(1)}d (positive ⇒ R4 LEADS R2)`,
    `    lag share       real ${(real.lag / Math.max(1, real.n)).toFixed(3)}   placebo ${lagB.lo.toFixed(3)} … ${lagB.hi.toFixed(3)}   ` +
      `VERDICT ${lagB.verdict} the band${note(lagB.verdict)}`,
    `    lead share      real ${(real.lead / Math.max(1, real.n)).toFixed(3)}   placebo ${leadB.lo.toFixed(3)} … ${leadB.hi.toFixed(3)}   ` +
      `VERDICT ${leadB.verdict} the band${note(leadB.verdict)}`,
    `    median (days)   real ${real.med.toFixed(1)}   placebo ${medB.lo.toFixed(1)} … ${medB.hi.toFixed(1)}   ` +
      `VERDICT ${medB.verdict} the band${note(medB.verdict)}`,
    `                    (${PLACEBO_SHIFTS.length} arms, R4 rotated ±1/2/3y — same count and run structure, wrong dates)`,
  ].join("\n");
}

// ---------- the ARGMAX arm: where the fold's max term binds ----------

/**
 * Grid severity of a confirmed state, on `SEV_NUM`'s scale — `severityOf` + `SEV_NUM`
 * (`danger-member-state.ts`) compose to RED→lit→1, AMBER→elev→0.5, anything else→calm→0.
 * `severityOf` is module-private there, so the three literals are restated here rather than imported.
 *
 * ⚠ A RESTATEMENT IS A CLAIM, so it is CHECKED, not asserted in prose — see
 * `assertSevMapMatchesProduction` below, which drives the real exported composition
 * (`memberScaledBand`) over every field member × every ladder leg × all three states and throws on
 * the first disagreement. Without that check nothing here would go red if `SEV_NUM` moved.
 */
const STATE_SEV: Record<string, number> = { RED: 1, AMBER: 0.5, GREEN: 0 };

/** `memberWeight` (`danger-engine.ts`) verbatim — absent member or absent leg ⇒ 0 reach. */
const legWeight = (member: string, leg: string): number => MEMBER_WEIGHT[member]?.[leg as LegKey] ?? 0;

/** The 9 ladder sleeves, in ladder order — the axis `observedWeightedMax` is evaluated per-leg over.
 *  Derived from the real `LEG_FIELD` export, so the leg set itself cannot drift out of sync; what CAN
 *  drift is `MEMBER_WEIGHT` gaining/losing a leg without `LEG_FIELD`, which the assertion below catches. */
const LEGS = LEG_FIELD.map((l) => l.sleeve);

/**
 * THE RESTATEMENT GUARD — this probe's only re-typed production constant, checked against the real
 * exports rather than trusted. `memberScaledBand(m, state, [leg])` (`danger-engine.ts`) IS
 * `scaledSevBand(memberWeight(m, leg) · SEV_NUM[severityOf(state)])`, so driving it over the real
 * `MEMBER_WEIGHT` rows of every field member × all 9 legs × all 3 states pins `STATE_SEV` against
 * production everywhere this probe actually uses it: the banding of a weighted severity. It also
 * catches `MEMBER_WEIGHT` and `LEG_FIELD` drifting apart (a member row keyed by a sleeve the ladder
 * no longer has, or vice versa).
 *
 * CAN FIRE (working tree, 2026-07-26, both restored by re-typing): setting `STATE_SEV.AMBER` to
 * `0.8` throws "STATE_SEV drift: R1 × Semis @ AMBER — this probe bands 0.8000 as RED, production's
 * memberScaledBand says AMBER"; dropping `Semis` from `LEGS` throws "MEMBER_WEIGHT.R1 is keyed by
 * Semis, which LEG_FIELD does not list". It is NOT a full VALUE pin (a band is an interval, so a
 * small enough drift can hide inside one), which is why the message says "drift" — but no drift
 * that would change a real cell's band can survive it, and that is the only property used below.
 */
function assertSevMapMatchesProduction(members: readonly string[]): void {
  for (const m of members) {
    const row = MEMBER_WEIGHT[m];
    if (!row) throw new Error(`[probe-r2-r4] ${m} has no MEMBER_WEIGHT row — the argmax field would read it as zero reach`);
    const extra = Object.keys(row).filter((leg) => !LEGS.includes(leg));
    if (extra.length > 0) {
      throw new Error(
        `[probe-r2-r4] MEMBER_WEIGHT.${m} is keyed by ${extra.join(", ")}, which LEG_FIELD does not list — ` +
          `the ladder shape and the weight table have drifted apart, so every per-leg count below is short.`,
      );
    }
    for (const leg of LEGS) {
      for (const state of ["RED", "AMBER", "GREEN"] as const) {
        const mine = scaledSevBand((legWeight(m, leg) * STATE_SEV[state]!) as Sev);
        const prod = memberScaledBand(m, state, [leg]);
        if (mine !== prod) {
          throw new Error(
            `[probe-r2-r4] STATE_SEV drift: ${m} × ${leg} @ ${state} — this probe bands ` +
              `${(legWeight(m, leg) * STATE_SEV[state]!).toFixed(4)} as ${mine}, production's ` +
              `memberScaledBand says ${prod}. The re-typed SEV_NUM literals no longer match ` +
              `danger-engine.ts; fix STATE_SEV before reading any share below.`,
          );
        }
      }
    }
  }
}

/** rt members with a committed OFFLINE fixture. R7 is a composite (three inputs, no single fixture)
 *  and is built separately; `EURC` / `BUND` have NO committed euro-curve CSV in
 *  `scripts/backtest/data/`, so they cannot enter the field at all — see `argmaxTable`'s bound note. */
const RT_FIXTURE: Record<string, string> = {
  R1: "scripts/backtest/data/t10y3m.csv",
  R2: "scripts/backtest/data/dgs10.csv",
  R3: "scripts/backtest/data/dgs2.csv",
  R4: "scripts/backtest/data/dfii10.csv",
  R6: "scripts/backtest/data/move.csv",
};

interface RtField {
  /** covered members, i.e. the field the argmax actually runs over */
  members: string[];
  /** `FAMILY_MEMBERS.rt` entries with no offline fixture — NOT in the field */
  missing: string[];
  /** dates on which EVERY covered member has a confirmed state */
  dates: string[];
  /** member id → per-date grid severity, index-aligned to `dates` */
  sev: Record<string, number[]>;
}

/**
 * Every `FAMILY_MEMBERS.rt` member this repo can score OFFLINE, through its PRODUCTION chain, joined
 * on date. Each covered member is scored exactly as its own event-study arm scores it
 * (`confirmedStateLabels` for the five FRED/level members, `bullSteepenerReadingSeries` for R7 —
 * whose `.state` is already 2-close folded by `buildReadings`), so nothing here re-implements a
 * state rule.
 *
 * GUARD (can fail — see the file docblock's CAN-FIRE DEMO): the argmax is only interesting against a
 * FIELD, so fewer than two rivals besides R2/R4 degenerates it into the pairwise R2-vs-R4 check that
 * runs beside it, and it throws rather than printing a number that says less than its label claims.
 */
function buildRtField(): RtField {
  const per = new Map<string, Map<string, string>>();
  for (const id of FAMILY_MEMBERS.rt) {
    const fixture = RT_FIXTURE[id];
    if (fixture) {
      const ind = ALL_INDICATORS.find((i) => i.id === id);
      if (!ind) throw new Error(`[probe-r2-r4] ${id} is in FAMILY_MEMBERS.rt but not in ALL_INDICATORS`);
      per.set(id, new Map(confirmedStateLabels(ind, fixture).map((p) => [p.date, p.bucket])));
    } else if (id === "R7") {
      const readings = bullSteepenerReadingSeries(
        R7,
        readFixture("scripts/backtest/data/t10y3m.csv"),
        readFixture("scripts/backtest/data/dgs2.csv"),
        readFixture("scripts/backtest/data/dgs10.csv"),
      );
      per.set(id, new Map(readings.map((r) => [r.date, r.state])));
    }
  }
  const members = [...per.keys()];
  const missing = FAMILY_MEMBERS.rt.filter((id) => !per.has(id));
  const rivals = members.filter((m) => m !== "R2" && m !== "R4");
  if (rivals.length < 2) {
    throw new Error(
      `[probe-r2-r4] the rt argmax field has only ${rivals.length} rival member(s) besides R2/R4 ` +
        `(${rivals.join(", ") || "none"}). An "argmax over the field" with fewer than two rivals is just ` +
        `the pairwise R2-vs-R4 comparison printed under a stronger name — fix RT_FIXTURE (or the R7 arm) ` +
        `before reading any share below.`,
    );
  }
  assertSevMapMatchesProduction(members);
  const first = per.get(members[0]!)!;
  const dates = [...first.keys()].filter((d) => members.every((m) => per.get(m)!.has(d))).sort();
  if (dates.length < 1000) {
    throw new Error(
      `[probe-r2-r4] the ${members.length}-member rt argmax window is only ${dates.length} days ` +
        `(expected ~5,800 — dfii10.csv from 2003-01 is the binding leg). The fixtures' date shapes have ` +
        `diverged; every share below would be vacuous.`,
    );
  }
  const sev: Record<string, number[]> = {};
  for (const m of members) sev[m] = dates.map((d) => STATE_SEV[per.get(m)!.get(d)!] ?? 0);
  return { members, missing, dates, sev };
}

/** Legs on which `me`'s weighted severity STRICTLY beats every other field member's, on day `i`. */
function strictArgmaxLegs(f: RtField, me: string, i: number): string[] {
  return LEGS.filter((leg) => {
    const mine = legWeight(me, leg) * f.sev[me]![i]!;
    if (mine <= 0) return false; // a calm/zero-reach member never binds a max fold
    return f.members.every((m) => m === me || legWeight(m, leg) * f.sev[m]![i]! < mine);
  });
}

/** Legs on which `a`'s weighted severity strictly beats `b`'s alone (the PAIRWISE, two-member view). */
function strictBeatLegs(f: RtField, a: string, b: string, i: number): string[] {
  return LEGS.filter((leg) => legWeight(a, leg) * f.sev[a]![i]! > legWeight(b, leg) * f.sev[b]![i]!);
}

const histogram = (legs: readonly string[][]): string => {
  const counts = new Map<string, number>();
  for (const set of legs) for (const l of set) counts.set(l, (counts.get(l) ?? 0) + 1);
  const rows = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  return rows.length === 0 ? "none" : rows.map(([l, c]) => `${l} ${c}`).join(" · ");
};

/**
 * THE STRICT-ARGMAX TABLE — the check slice 1 deferred, and the only one that measures rather than
 * bounds. The marginal day-counts above say how often each member is AMBER+ while the other is not;
 * they do NOT say whether that member's cell ever BINDS, because `observedWeightedMax`
 * (`danger-engine.ts`) folds `MEMBER_WEIGHT × SEV_NUM` over EVERY observed relevant
 * `FAMILY_MEMBERS.rt` member, per leg, via `quasiMaxFold`. A member beaten on all nine legs never
 * sets the max term — but it still enters the breadth bonus's mean of the rest, so "not the argmax"
 * is NOT "contributes nothing"; that residual is the leave-one-out arm's to count.
 *
 * ⚠ THE FIELD IS INCOMPLETE, AND FOR THE ARGMAX THE BIAS HAS A KNOWN DIRECTION. Members without a
 * committed fixture are absent (printed by the run). Adding a member can only
 * ADD rivals to the `every(... < mine)` test, so every share printed here is an UPPER BOUND on the
 * true binding share — never a point estimate. A LOW share is therefore the strong result; a high
 * one is "at most this often", which is why the WHOLE-WINDOW block below is printed with it.
 * An absentee with no `MEMBER_WEIGHT` row (weight 0 on all nine legs) cannot tighten the bound even
 * if a fixture appeared.
 *
 * ⚠ NO PLACEBO ARM, DELIBERATELY. This is not a conditional-return claim
 * (`research-probes.md` §"A conditional-return claim owes a PLACEBO arm") — it is a deterministic
 * accounting of the fold over the SAME days, with no forward window and no return. Rotating dates
 * here would compare the fold against a fold on other days, which answers nothing that was asked.
 */
function argmaxTable(f: RtField, r2Amber: boolean[], r4Amber: boolean[], fullWindow: number): string {
  const idx = f.dates.map((_, i) => i);
  const only2 = idx.filter((i) => r2Amber[i] && !r4Amber[i]);
  const only4 = idx.filter((i) => !r2Amber[i] && r4Amber[i]);
  const both = idx.filter((i) => r2Amber[i] && r4Amber[i]);
  const share = (hits: number, n: number): string =>
    n === 0 ? "n/a (empty bucket)" : `${hits}/${n} = ${pct(hits / n)}`;

  const a2 = only2.map((i) => strictArgmaxLegs(f, "R2", i));
  const a4 = only4.map((i) => strictArgmaxLegs(f, "R4", i));
  const bothPair = both.map((i) => strictBeatLegs(f, "R2", "R4", i));
  const bothField = both.map((i) => strictArgmaxLegs(f, "R2", i));

  // State-pair decomposition of the co-firing days. It is the WHOLE mechanism of the pairwise row:
  // with rows identical but for `Semis`, R2 can beat R4 on `Semis` ALONE when the two states are
  // equal — but when R2 is RED and R4 only AMBER it beats R4 on all nine legs, and when R4 is the
  // worse state R2 beats it nowhere. Printed so the pairwise share can never be read as "Semis".
  const pairCounts = new Map<string, number>();
  for (const i of both) {
    const key = `R2 ${f.sev.R2![i] === 1 ? "RED" : "AMBER"} / R4 ${f.sev.R4![i] === 1 ? "RED" : "AMBER"}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  return [
    `\nSTRICT-ARGMAX BINDING — AMBER-or-worse, over ${f.dates.length} days ${f.dates[0]} → ${f.dates.at(-1)}`,
    `  field             ${f.members.join(", ")}   (${f.members.length} of ${FAMILY_MEMBERS.rt.length} FAMILY_MEMBERS.rt)`,
    `  NOT in the field  ${f.missing.join(", ") || "none"}   ← no committed offline fixture ⇒ every share below is an UPPER BOUND`,
    `                    of those, only ${f.missing.filter((m) => MEMBER_WEIGHT[m]).join(", ") || "none"} can lower a share — ` +
      `${f.missing.filter((m) => !MEMBER_WEIGHT[m]).join(", ") || "none"} have NO MEMBER_WEIGHT row (0 reach on all 9 legs)`,
    `  window            ${f.dates.length} days vs the ${fullWindow}-day R2/R4 window above — the bucket counts here are SMALLER for that reason alone`,
    `\n  R2-only AMBER+ days  ${only2.length}`,
    `    R2 is the STRICT weighted-severity argmax on ≥1 leg: ${share(a2.filter((l) => l.length > 0).length, only2.length)}`,
    `      legs it binds:  ${histogram(a2)}`,
    `\n  R4-only AMBER+ days  ${only4.length}   (the mirror direction, for scale)`,
    `    R4 is the STRICT weighted-severity argmax on ≥1 leg: ${share(a4.filter((l) => l.length > 0).length, only4.length)}`,
    `      legs it binds:  ${histogram(a4)}`,
    `\n  CO-FIRING AMBER+ days  ${both.length}   ← the load-bearing bucket: R2 is a near-subset of R4`,
    `    R2 strictly beats R4 (PAIRWISE, ignoring the other members) on ≥1 leg: ${share(bothPair.filter((l) => l.length > 0).length, both.length)}`,
    `      legs:           ${histogram(bothPair)}`,
    `    R2 is the STRICT argmax over the WHOLE field on ≥1 leg:               ${share(bothField.filter((l) => l.length > 0).length, both.length)}`,
    `      legs:           ${histogram(bothField)}`,
    `    state pairs:      ${[...pairCounts.entries()].map(([k, c]) => `${k} ${c}`).join(" · ") || "none"}`,
    // ⚠ EVERY share above is WITHIN-BUCKET, and the buckets are rare. A within-bucket share answers
    // "when this bucket occurs, how often does R2 bind?" — it says nothing about how often that is.
    // Printed here so the two can never be quoted apart (review fix, 2026-07-26).
    `\n  WHOLE-WINDOW DENOMINATOR — the same counts over all ${f.dates.length} days, not their buckets:`,
    `    R2-only bucket        ${only2.length}/${f.dates.length} = ${pct2(only2.length / f.dates.length)} of days; R2 binds on ` +
      `${a2.filter((l) => l.length > 0).length}/${f.dates.length} = ${pct2(a2.filter((l) => l.length > 0).length / f.dates.length)}`,
    `    co-firing bucket      ${both.length}/${f.dates.length} = ${pct2(both.length / f.dates.length)} of days; R2 is field argmax on ` +
      `${bothField.filter((l) => l.length > 0).length}/${f.dates.length} = ${pct2(bothField.filter((l) => l.length > 0).length / f.dates.length)}`,
    `    COMBINED — R2 is the field argmax on ≥1 leg on ` +
      `${a2.filter((l) => l.length > 0).length + bothField.filter((l) => l.length > 0).length}/${f.dates.length} = ` +
      `${pct2((a2.filter((l) => l.length > 0).length + bothField.filter((l) => l.length > 0).length) / f.dates.length)} of ALL days`,
    `    ⇒ never quote a within-bucket share without this line: each is conditional on a bucket that`,
    `      is itself rare, and each is an upper bound on top of that.`,
  ].join("\n");
}

/**
 * THE LEAVE-ONE-OUT ARM — the only one that answers the DISPOSITION question directly, and it was
 * added at review (2026-07-26) because the argmax table above does not answer it.
 *
 * "R2 is the strict argmax on ≥1 leg" says R2's cell is the one the max fold picks. It does NOT say
 * REMOVING R2 would change anything: the runner-up member may sit a hair below R2 and land in the
 * same `SEV_CUTS` band, in which case the rt cell's STATE — the only thing downstream of
 * `observedWeightedMax` that anyone reads — is identical with and without R2. So this arm re-scores
 * the rt cell TWICE per day per leg, with and without R2, and reports two nested counts over the
 * WHOLE window (not a within-bucket share):
 *   • days R2 strictly RAISES some leg's `wsev` (⊇ the argmax days, and under the quasi-max strictly
 *     wider: a non-argmax R2 still lifts the breadth bonus), and
 *   • days that raise crosses a `SEV_CUTS` boundary, i.e. the leg's BAND actually differs.
 * The second count is the one a "do not thin R2" argument may lean on; the first is an upper bound
 * on it.
 *
 * MEASURED 2026-07-26 over 5,792 days: R2 raises some leg's `wsev` on 72 days (1.24%) — exactly the
 * 33 + 39 argmax days above — but moves a BAND on only 34 (0.59%), on `EM 34 · S&P 500 30 ·
 * ex-US 30 · Value 4 · Health 4` (98 GREEN→AMBER + 4 AMBER→RED leg-days). **`Semis` NEVER moves a
 * band, not once**, though it is the leg R2 raises most often (45 days): R2 `Semis` 1.0 against R4
 * `Semis` 0.6 is 0.5 vs 0.3, or 0.5 vs 0.4 — AMBER either way. So the then-differing `Semis` cell, the
 * one that made R2 the argmax at all, was the one cell with zero band impact. COUNTED, not inferred: of
 * the 34 band-moving days, **31 are R2-only** (R2 lit while R4 is not) and 3 are co-firing days
 * where R2 holds the worse state. The reason not to thin R2 is therefore the R2-only marginal, not
 * the `Semis` differentiation.
 *
 * ⚠ THIS WHOLE BLOCK IS A **PRE-DEMOTION** MEASUREMENT, and it stays that way. R2's `Semis` cell moved
 * 1.0 → 0.6 on 2026-08-03, so from 2026-08-03 until 2026-08-04 R2
 * and R4 were cell-for-cell equal and the R2-vs-R4 **differentiation** on `Semis` was gone (2026-08-04
 * re-diverged them the other way round — see the header). ⚠ The 45-day `Semis` RAISE is NOT gone, only
 * weakened, and only on co-firing days: this arm scores R2 against the WHOLE `rt` field
 * (`others = f.members.filter(m => m !== me)`), never against R4 alone. On the R2-only days — 31 of the
 * 34 band-movers — R2 lit still out-weighs the runner-up rt members whose `Semis` cells are heavier but
 * only ELEVATED (`SEV_NUM.lit` = 1 vs `elev` = 0.5), so it keeps raising `Semis`. What the demotion
 * removed is the raise on days R4 co-fires, where the two cells were identical over the 2026-08-03 → 2026-08-04 window. §11.3 **WAIVES** the re-run as a
 * stated cost — the numbers above are deliberately left as the pre-demotion record and are NOT a missing
 * follow-through. They also **predate the 2026-07-23 R4 retune**; any quote of them must carry that tag.
 * ⚠ This probe's control arm reads production constants, so between 2026-08-03 and 2026-08-04 a re-run
 * would have compared R4 against an identical R2 and collapsed to A/A by construction. That hazard is lifted — the
 * rows re-diverged on `Semis` on 2026-08-04 — but a re-run still needs an in-probe frozen `Semis: 1.0`
 * literal to reproduce the pre-demotion baseline, not just a rerun.
 *
 * Same INCOMPLETE-FIELD caveat as `argmaxTable`, but it no longer cuts one way: the cell folds through
 * production's imported `quasiMaxFold`/`BREADTH_LAMBDA` (the hand-typed plain max it replaced, 2026-09-26,
 * had gone stale), whose breadth bonus averages every non-max term — so a seated absentee can lower the
 * cell as well as raise it, and both counts are the field's, NOT upper bounds. Weight-0 members are
 * dropped before the fold, as production's `isRelevant` filter does (a 0 term would dilute the mean).
 */
function leaveOneOutTable(f: RtField, me: string, r2Amber: boolean[], r4Amber: boolean[]): string {
  const others = f.members.filter((m) => m !== me);
  const raiseLegs: string[][] = [];
  const bandLegs: string[][] = [];
  const bandPairs = new Map<string, number>();
  const bandBucket = new Map<string, number>();
  for (let i = 0; i < f.dates.length; i++) {
    const rl: string[] = [];
    const bl: string[] = [];
    for (const leg of LEGS) {
      const fold = (ms: readonly string[]): number =>
        quasiMaxFold(
          ms.filter((m) => legWeight(m, leg) > 0).map((m) => legWeight(m, leg) * f.sev[m]![i]!),
          BREADTH_LAMBDA,
        );
      const wsevWith = fold(f.members);
      const wsevWithout = fold(others);
      if (wsevWith < wsevWithout && scaledSevBand(wsevWith as Sev) !== scaledSevBand(wsevWithout as Sev)) {
        // The band counts below are raise-conditioned; a presence that LOWERS a band (possible under
        // the quasi-max's diluting bonus, zero on the committed fixtures) would drop out of them silently.
        throw new Error(
          `[probe-r2-r4] ${me} LOWERS ${leg}'s rt band on ${f.dates[i]} (${wsevWithout.toFixed(4)} → ` +
            `${wsevWith.toFixed(4)}) — the raise-only band counts no longer cover ${me}'s band impact; count both directions.`,
        );
      }
      if (wsevWith <= wsevWithout) continue;
      rl.push(leg);
      const bWith = scaledSevBand(wsevWith as Sev);
      const bWithout = scaledSevBand(wsevWithout as Sev);
      if (bWith === bWithout) continue;
      bl.push(leg);
      const key = `${bWithout} → ${bWith}`;
      bandPairs.set(key, (bandPairs.get(key) ?? 0) + 1);
    }
    if (rl.length > 0) raiseLegs.push(rl);
    if (bl.length > 0) {
      bandLegs.push(bl);
      // WHICH bucket the band-moving days come from — the disposition turns on this, so it is
      // counted, never inferred from the two argmax histograms lining up.
      const key = r2Amber[i] && r4Amber[i] ? "co-firing" : r2Amber[i] ? `${me}-only` : "neither lit";
      bandBucket.set(key, (bandBucket.get(key) ?? 0) + 1);
    }
  }
  const n = f.dates.length;
  const bandLegSet = new Set(bandLegs.flat());
  const silent = LEGS.filter((l) => !bandLegSet.has(l));
  return [
    `\nLEAVE-ONE-OUT BAND IMPACT — drop ${me} from the rt field, re-score the cell, over all ${n} days`,
    `  field WITH ${me}        ${f.members.join(", ")}`,
    `  field WITHOUT        ${others.join(", ")}   (same incomplete field — under the quasi-max the bias has no known sign, so both counts below are the field's, not bounds)`,
    `  SEV_CUTS             amber ${SEV_CUTS.amber} · red ${SEV_CUTS.red}   ← the cuts the rt cell's band is read at`,
    `  days ${me} strictly RAISES ≥1 leg's wsev:   ${raiseLegs.length}/${n} = ${pct2(raiseLegs.length / n)}`,
    `      legs raised:    ${histogram(raiseLegs)}`,
    `  days that raise MOVES ≥1 leg's BAND:      ${bandLegs.length}/${n} = ${pct2(bandLegs.length / n)}   ← the count a "do not thin ${me}" argument may lean on`,
    `      legs moved:     ${histogram(bandLegs)}`,
    `      band moves:     ${[...bandPairs.entries()].sort((x, y) => y[1] - x[1]).map(([k, c]) => `${k} ${c}`).join(" · ") || "none"}   (leg-days)`,
    `      from BUCKET:    ${[...bandBucket.entries()].sort((x, y) => y[1] - x[1]).map(([k, c]) => `${k} ${c}`).join(" · ") || "none"}`,
    `      NEVER moved:    ${silent.join(" · ") || "none"}   ← ${me} raises wsev on these legs (or not at all) but never across a cut`,
  ].join("\n");
}

function main(): void {
  const dgs10 = readFixture("scripts/backtest/data/dgs10.csv");
  const dfii10 = readFixture("scripts/backtest/data/dfii10.csv");
  for (const [name, s] of [
    ["dgs10.csv", dgs10],
    ["dfii10.csv", dfii10],
  ] as const) {
    console.log(
      `${name.padEnd(12)} ${String(s.length).padStart(6)} rows  ${s[0]!.date} → ${s.at(-1)!.date}  latest ${s.at(-1)!.value}`,
    );
  }

  const R2 = ALL_INDICATORS.find((i) => i.id === "R2");
  const R4 = ALL_INDICATORS.find((i) => i.id === "R4");
  if (!R2 || !R4) throw new Error("[probe-r2-r4] R2 / R4 not in ALL_INDICATORS");

  // Both members through their PRODUCTION chains; joined on date, never on index — DGS10 starts
  // 1962 and DFII10 only 2003, so the two state series begin thousands of rows apart.
  const r2States = new Map(confirmedStateLabels(R2, "scripts/backtest/data/dgs10.csv").map((p) => [p.date, p.bucket]));
  const r4States = new Map(confirmedStateLabels(R4, "scripts/backtest/data/dfii10.csv").map((p) => [p.date, p.bucket]));
  const dates = [...r2States.keys()].filter((d) => r4States.has(d)).sort();
  const n = dates.length;
  if (n < 1000) {
    throw new Error(
      `shared history is only ${n} days (expected ~5,850 — dfii10.csv from 2003-01 is the binding leg) ` +
        `— the fixtures' date shapes have diverged, so every metric would be vacuous. Inspect the raw CSVs first.`,
    );
  }

  console.log(
    `\n${"═".repeat(78)}\nR2 (DGS10 10y NOMINAL Δ20)  vs  R4 (DFII10 10y REAL Δ20)   ${n} shared days  ${dates[0]} → ${dates.at(-1)}`,
  );

  // --- axis correlations + the identity decomposition ---
  const byDate = (obs: typeof dgs10): Map<string, number> => new Map(obs.map((o) => [o.date, o.value]));
  const lvlN = byDate(dgs10);
  const lvlR = byDate(dfii10);
  const dN = byDate(dgs10.slice(VELOCITY_WINDOW).map((o, i) => ({ date: o.date, value: o.value - dgs10[i]!.value })));
  const dR = byDate(dfii10.slice(VELOCITY_WINDOW).map((o, i) => ({ date: o.date, value: o.value - dfii10[i]!.value })));
  const axDates = dates.filter((d) => lvlN.has(d) && lvlR.has(d) && dN.has(d) && dR.has(d));
  const lvN = axDates.map((d) => lvlN.get(d)!);
  const lvR = axDates.map((d) => lvlR.get(d)!);
  const vN = axDates.map((d) => dN.get(d)!);
  const vR = axDates.map((d) => dR.get(d)!);
  const vB = vN.map((v, i) => v - vR[i]!); // Δ20 breakeven, by the identity
  const rLevel = pearson(lvN, lvR);
  const rVel = pearson(vN, vR);
  const sdN = sd(vN);
  const sdR = sd(vR);
  const sdB = sd(vB);
  const identityOnly = sdR / sdN; // the ORTHOGONAL-CASE r: the identity alone, if Δb ⊥ Δr. Not a bound.
  const economic = cov(vB, vR) / (sdN * sdR); // the remainder: breakeven ↔ real co-movement

  console.log(`\nAXIS CORRELATIONS over ${axDates.length} days:`);
  console.log(
    `  level r(DGS10, DFII10)        ${rLevel.toFixed(4)}   ${rLevel >= SAME_FACTOR_R ? "≥" : "<"} ${SAME_FACTOR_R.toFixed(2)} same-factor line`,
  );
  console.log(
    `  Δ${VELOCITY_WINDOW} r(nominal, real)          ${rVel.toFixed(4)}   ${rVel >= SAME_FACTOR_R ? "≥" : "<"} ${SAME_FACTOR_R.toFixed(2)} same-factor line   ← THE PLAN'S TEST, and it is CONFOUNDED`,
  );
  console.log(`\nCONFOUND SIZING — DGS10 ≡ DFII10 + breakeven, so Δ20 nominal CONTAINS Δ20 real by identity:`);
  console.log(
    `  σ(Δ20 nominal)  ${sdN.toFixed(4)}   σ(Δ20 real)  ${sdR.toFixed(4)}   σ(Δ20 breakeven)  ${sdB.toFixed(4)}`,
  );
  console.log(
    `  IDENTITY-ONLY BASELINE  σr/σn = ${identityOnly.toFixed(4)}   ← the ORTHOGONAL-CASE r: what the identity alone produces if Δbreakeven were ⊥ Δreal. A BASELINE, not a floor — the residual below is signed, so r can land under it`,
  );
  console.log(
    `  economic residual cov(Δb,Δr)/(σn·σr) = ${economic >= 0 ? "+" : ""}${economic.toFixed(4)}   ← the only non-mechanical part (sums to ${(identityOnly + economic).toFixed(4)} = the Δ20 r above)`,
  );
  console.log(
    `  r(Δ20 breakeven, Δ20 real)    ${pearson(vB, vR).toFixed(4)}   ← if this were 0 the Δ20 r would BE the identity-only baseline`,
  );
  // THREE-WAY, like `band`: the residual can be NEGATIVE, and then the measured r sits BELOW the
  // identity-only baseline — "N% of r is mechanical" would print >100% and read as nonsense. Say
  // what actually happened instead: the identity over-explains the correlation and breakeven
  // co-movement pushes it DOWN. Either way the conclusion is the same — this number cannot settle
  // the question, which is why the next line points at the state overlap.
  console.log(
    economic < 0
      ? `  ⇒ the measured Δ20 r is BELOW its identity-only baseline (${rVel.toFixed(4)} < ${identityOnly.toFixed(4)}): the identity` +
          ` alone would predict MORE co-movement than was measured, and breakeven co-movement SUBTRACTS ${Math.abs(economic).toFixed(4)}` +
          ` (breakeven partly OFFSETS real moves). The decomposition attributes the co-movement to the identity, but an algebraic` +
          ` identity holds for ANY pair where one series contains the other, so it rules nothing out on its own.`
      : `  ⇒ ${((identityOnly / Math.max(1e-9, rVel)) * 100).toFixed(1)}% of the measured Δ20 r is mechanical; the rest is breakeven co-movement.`,
  );
  console.log(`     Read the STATE OVERLAP below — where the two members' different cuts can disagree — not this number.`);

  const ll = leadLag(vR, vN, LAG_DELTA);
  // An argmax is only a lead/lag reading when it is INTERIOR to the scan and rides a real
  // correlation. Pinned to the ±LAG_DELTA rail ⇒ the true max is outside the window and the printed
  // k is the rail, not a lag; |r| under the floor ⇒ the peak is noise and the k is meaningless
  // whatever its position. Either way the k is SUPPRESSED.
  const railPinned = Math.abs(ll.k) === LAG_DELTA;
  const belowFloor = Math.abs(ll.r) < LL_R_FLOOR;
  const warn =
    (railPinned ? `  ⚠ argmax PINNED to the ±${LAG_DELTA}d scan rail — the true max lies OUTSIDE the window` : "") +
    (belowFloor ? `  ⚠ |r| < ${LL_R_FLOOR.toFixed(2)} floor — a noise peak, not a lead/lag` : "");
  const kShown = railPinned || belowFloor ? "  n/a" : String(ll.k).padStart(4);
  console.log(
    `  LL  Δ20 real leads Δ20 nominal  k=${kShown}  r=${ll.r.toFixed(4)}   (positive k ⇒ the REAL move comes FIRST;` +
      ` k=0 is the identity's own answer)${warn}${warn ? `  [argmax k=${ll.k} suppressed]` : ""}`,
  );

  // --- state overlap: the load-bearing measure ---
  for (const [label, fires] of [
    ["AMBER-or-worse", (s: string) => s === "AMBER" || s === "RED"],
    ["RED", (s: string) => s === "RED"],
  ] as const) {
    const r2F = dates.map((d) => fires(r2States.get(d)!));
    const r4F = dates.map((d) => fires(r4States.get(d)!));
    console.log(overlapTable(label, r2F, r4F, n));
    console.log(onsetTable(label, r2F, r4F));
  }

  // --- the argmax arm: on which of those marginal/co-firing days the fold's max term binds ---
  const field = buildRtField();
  const amberPlus = (m: string): boolean[] => field.sev[m]!.map((s) => s > 0);
  console.log(argmaxTable(field, amberPlus("R2"), amberPlus("R4"), n));
  console.log(leaveOneOutTable(field, "R2", amberPlus("R2"), amberPlus("R4")));
}

main();
