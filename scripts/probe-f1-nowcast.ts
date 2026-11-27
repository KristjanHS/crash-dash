/**
 * S1 — F1 SAME-DAY HY-OAS NOWCAST FIT PROBE (blocking stage).
 * PRE-REGISTERED, measurement only:
 * this script emits the per-arm numbers and STOPS. It applies NO ruling — no registry edit,
 * no `src/` change, no lane. The pass/fail call is P5 alone.
 *
 * Contract = §S1 pre-registration (P1–P8) of the plan. Nothing here is tuned after a result.
 *
 *   P1  F1 = stitchHyOas(loadHyOasVintage(), <live BAMLH0A0HYM2 tail>), clipped 2015-01-01→today.
 *       Prices via fetchDailyCloses(sym,{deep:true}) for HYG/LQD/IEF/IEI. IEI is a PROBE-ONLY
 *       fetch (P7) — it is NOT added to INPUT_SERIES.
 *   P2  Hold-out: FIT on 2015-01-01→2019-12-31, SCORE on 2020-01-01→today. Constants frozen on
 *       the fit half before the score half is touched.
 *   P3  Per arm, one OLS (through the origin) of daily ΔOAS on the arm's return legs. Recover:
 *         HY_SPREAD_DURATION = −1 / coef(r_HYG)                         [years]
 *         β                  =  coef(r_hedge) · HY_SPREAD_DURATION      [dimensionless hedge ratio]
 *       Arm A (raw HYG) is the 1-parameter case, no β.
 *   P4  Tail subset = the worst 50 daily |ΔOAS| moves WITHIN the score window.
 *   P5  An arm PASSES iff its tail sign agreement ≥ 32/50 (64%). If no arm clears it the plan
 *       stops at S1 (negative result).
 *   P6  Four arms: A raw HYG · B HYG−LQD · C HYG−IEF · D HYG−IEI.
 *   P8  Per arm: score-window RMSE · full-window sign agreement · tail sign agreement (the decision
 *       number) · worst-case |error| on the tail · fitted β and HY_SPREAD_DURATION · actual first
 *       aligned date.
 *
 * ── SIGN CONVENTIONS (stated per the task; both matter) ──────────────────────────────
 *   Returns: DAILY LOG returns. Because a frame-interval log return equals the SUM of the daily
 *     log returns over the intervening sessions, a multi-day gap (a Monday nowcast after a Friday
 *     print, or an OAS-missing day) is accumulated automatically — no separate loop needed.
 *   Estimator (N3): oasEst(T) = oasFred(Dprev) − Σ excessReturn / spreadDuration. A NEGATIVE excess
 *     return (credit selling off) RAISES the estimated OAS — that is the whole point, so the sum
 *     is SUBTRACTED. This uses N3's minus sign (the shape sketch's "+" contradicts its own note).
 *   β sign: excessReturn = r_HYG − β·r_hedge with β > 0 (removes HYG's rate exposure, "matching
 *     HYG's rate duration to the hedge's", P3). This is β = coef(r_hedge)·HY_SPREAD_DURATION, i.e.
 *     β = −coef(r_hedge)/coef(r_HYG); with coef(r_HYG)<0 and coef(r_hedge)>0 it comes out positive.
 *     It is also the ONLY sign that makes the reconstruction reproduce the fitted regression:
 *     −excess/D = coef(r_HYG)·r_HYG + coef(r_hedge)·r_hedge. (The task text's literal
 *     "β = −coef(r_hedge)·D" is the negative of this and would sabotage arms B/C/D — deliberately
 *     not used; see the final report's judgement-call note.)
 *
 * OFFLINE for the vintage; NETWORK for the live FRED tail + the four price series.
 */
import { loadHyOasVintage, requireVintage } from "../src/hyoas-vintage.js";
import { stitchHyOas } from "../src/hyoas-history.js";
import { realFeeds } from "../src/feed-ports.js";
import { fetchDailyCloses } from "../src/prices.js";
import { alignByDates } from "../src/scorers-core.js";
import type { Observation } from "../src/domain-types.js";
import { nowcastHyOas, OAS_NOWCAST_LEGS } from "../src/hyoas-nowcast.js";
import { resolveCarryWindow } from "../src/nowcast-carry.js";
import { isoDay } from "../src/dates.js";
import { readEnv, type Env } from "../src/config.js";

const TODAY = isoDay(new Date());

/**
 * the issuer's PUBLISHED effective duration for HYG, read 2026-09-17. Not a fitted value — the
 * yardstick every fit is judged against, and THIS LINE IS ITS ONLY SOURCE (never restate it). the issuer publishes no separate spread duration, and for a
 * portfolio of HY bonds effective duration IS the `D` in ΔOAS ≈ −excess/D, so this is the right
 * comparand (Addendum A §Evidence). Re-read the fund page before trusting it after a rebalance.
 */
const HYG_PUBLISHED_DURATION_YEARS = 3.07;

/** Sanity bounds (P3): print a warning, never silently accept. */
const DURATION_MIN_YEARS = 1;
/**
 * Addendum A §S1b: the old ceiling was a vacuous absolute 10y — it passed every forward fit in the
 * run that RAISED Q2, so the guard could not have caught the thing it existed to catch. Bound the
 * forward fit against `HYG_PUBLISHED_DURATION_YEARS` instead. A fit above this is the EIV signature U1 brackets, not a pass.
 */
const DURATION_RATIO_FLAG = 1.5;
const BETA_ABS_MAX = 5;

type Arm = { key: string; label: string; hedge: number | null }; // hedge = index into value columns, or null
// value columns after alignByDates: 0=OAS 1=the target's price ETF 2..=its `hedges`, in order
const COL = { OAS: 0, PRICE: 1 } as const;

/** One nowcast target. `--target=<key>` picks it; every window/bar is pre-registered per target. */
type Target = {
  key: string;
  /** The shipped `OAS_NOWCAST_LEGS` row `--live` evaluates. */
  legId: keyof typeof OAS_NOWCAST_LEGS;
  fredSeries: string;
  /** F1 stitches its committed vintage under the live tail; a target without one is live-tail only. */
  stitchVintage: boolean;
  price: string;
  hedges: string[];
  arms: Arm[];
  clipStart: string;
  fitEnd: string; // FIT window: clipStart .. fitEnd inclusive
  scoreStart: string; // SCORE window: scoreStart .. today
  tailSize: number;
  tailPassBar: number;
  /** Second gate on the reverse-fit D's tail `react`; null = sign bar alone (S1's P5). */
  reactBand: readonly [number, number] | null;
  /** The published-duration yardstick; null = none read for this fund, its checks are skipped. */
  publishedDurationYears: number | null;
};

const TARGETS: Target[] = [
  {
    // S1 pre-registration P1–P8: 32/50 ≈ one-sided binomial p=0.033.
    key: "f1",
    legId: "F1",
    fredSeries: "BAMLH0A0HYM2",
    stitchVintage: true,
    price: "HYG",
    hedges: ["LQD", "IEF", "IEI"],
    arms: [
      { key: "A raw", label: "A  raw  (r_HYG)", hedge: null },
      { key: "B lqd", label: "B  lqd  (HYG−β·LQD)", hedge: 2 },
      { key: "C ief", label: "C  ief  (HYG−β·IEF)", hedge: 3 },
      { key: "D iei", label: "D  iei  (HYG−β·IEI)", hedge: 4 },
    ],
    clipStart: "2015-01-01",
    fitEnd: "2019-12-31",
    scoreStart: "2020-01-01",
    tailSize: 50,
    tailPassBar: 32,
    reactBand: null,
    publishedDurationYears: HYG_PUBLISHED_DURATION_YEARS,
  },
  {
    // Keyless F2 starts 2023-09-30; 18/25 bar + react band (inherited from an earlier lane, removed 2026-10-03).
    key: "f2",
    legId: "F2",
    fredSeries: "BAMLC0A0CM",
    stitchVintage: false,
    price: "LQD",
    hedges: ["IEF", "IEI"],
    arms: [
      { key: "A raw", label: "A  raw  (r_LQD)", hedge: null },
      { key: "C ief", label: "C  ief  (LQD−β·IEF)", hedge: 2 },
      { key: "D iei", label: "D  iei  (LQD−β·IEI)", hedge: 3 },
    ],
    clipStart: "2023-09-30",
    fitEnd: "2024-12-31",
    scoreStart: "2025-01-01",
    tailSize: 25,
    tailPassBar: 18,
    reactBand: [0.67, 1.5],
    publishedDurationYears: null,
  },
];

function clip(obs: Observation[], start: string, end: string): Observation[] {
  return obs.filter((o) => o.date >= start && o.date <= end);
}

/** OLS through the origin. cols = design columns (1 or 2), y = response. Returns coefficients. */
function olsThroughOrigin(cols: number[][], y: number[]): number[] {
  const p = cols.length;
  const n = y.length;
  // Normal equations XᵀX c = Xᵀy.
  const xtx: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  const xty: number[] = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      xty[a]! += cols[a]![i]! * y[i]!;
      for (let b = 0; b < p; b++) xtx[a]![b]! += cols[a]![i]! * cols[b]![i]!;
    }
  }
  if (p === 1) return [xty[0]! / xtx[0]![0]!];
  // 2x2 solve.
  const [a, b, c, d] = [xtx[0]![0]!, xtx[0]![1]!, xtx[1]![0]!, xtx[1]![1]!];
  const det = a * d - b * c;
  const c1 = (d * xty[0]! - b * xty[1]!) / det;
  const c2 = (-c * xty[0]! + a * xty[1]!) / det;
  return [c1, c2];
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** `--live`: the shipped estimator over today's live feeds — newest print, the carry window's closes, the estimate or why null. */
async function runLive(target: Target, env: Env): Promise<void> {
  const leg = OAS_NOWCAST_LEGS[target.legId];
  const [prints, price, hedge] = await Promise.all([
    realFeeds.fetchSeries(target.fredSeries, { now: new Date(), env }),
    fetchDailyCloses(leg.price, { now: Date.now, env }),
    fetchDailyCloses(leg.hedge, { now: Date.now, env }),
  ]);
  const at = (o: Observation | undefined) => (o ? `${o.date} ${o.value}` : "(none)");
  console.log(`═══ live nowcast — ${target.legId} ← ${leg.price} − ${leg.params.hedgeBeta}·${leg.hedge} (D=${leg.params.spreadDurationYears}y) ═══`);
  console.log(`newest ${target.fredSeries} print : ${at(prints.at(-1))}`);
  console.log(`newest ${leg.price} close       : ${at(price.at(-1))}`);
  console.log(`newest ${leg.hedge} close       : ${at(hedge.at(-1))}`);
  const carry = resolveCarryWindow(prints, [price, hedge]);
  if (carry) {
    console.log(`carry anchor print   : ${at(carry.print)}`);
    console.log(`base closes          : ${carry.bases.map((o) => at(o)).join(" · ")}`);
    console.log(`now closes           : ${carry.nows.map((o) => at(o)).join(" · ")}`);
  }
  const est = nowcastHyOas(prints, price, hedge, leg.params);
  if (est) {
    console.log(`oasEst               : ${est.value.toFixed(3)} on ${est.date} (from ${est.fromDate}; Δ ${(est.value - carry!.print.value).toFixed(3)} pp)`);
    return;
  }
  const why =
    prints.length === 0 || price.length === 0 || hedge.length === 0
      ? "an input feed returned no rows"
      : price.at(-1)!.date <= prints.at(-1)!.date
        ? "FRED has printed the newest close's date"
        : "no same-date hedge close / no exact-date base pair within the carry cap";
  console.log(`oasEst               : null — ${why}`);
}

async function main(): Promise<void> {
  const env = readEnv();
  const targetKey = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length) ?? "f1";
  const target = TARGETS.find((t) => t.key === targetKey);
  if (!target) throw new Error(`unknown --target=${targetKey} (have: ${TARGETS.map((t) => t.key).join(", ")})`);
  if (process.argv.includes("--live")) return runLive(target, env);
  const { fredSeries: FRED_SERIES, clipStart: CLIP_START, fitEnd: FIT_END, scoreStart: SCORE_START } = target;
  const { tailSize: TAIL_SIZE, tailPassBar: TAIL_PASS_BAR, arms: ARMS, publishedDurationYears: PUBLISHED } = target;
  const DURATION_MAX_YEARS = PUBLISHED === null ? Infinity : PUBLISHED * DURATION_RATIO_FLAG;
  const symbols = [target.price, ...target.hedges];

  // ── P1: build the OAS series (F1 = vintage ⊕ live FRED tail, the prod stitch) and the price series. ──
  const liveTail = await realFeeds.fetchSeries(FRED_SERIES, { fullHistory: true, now: new Date(), env });
  const warnings: string[] = [];
  const oasFull = target.stitchVintage
    ? stitchHyOas(requireVintage(loadHyOasVintage()), liveTail, (m) => warnings.push(m))
    : liveTail;

  const closes = await Promise.all(symbols.map((sym) => fetchDailyCloses(sym, { deep: true, now: Date.now, env })));

  const oas = clip(oasFull, CLIP_START, TODAY);
  // Frame = inner join on date (OAS ∩ every price series). ETF trading days and FRED
  // business days can disagree, so we inner-join rather than assume index parity.
  const joined = alignByDates([oas, ...closes.map((c) => clip(c, CLIP_START, TODAY))]);
  const dates = joined.dates;
  const V = joined.values; // V[col][i]
  const firstAligned = dates[0] ?? "(none)";
  const lastAligned = dates[dates.length - 1] ?? "(none)";

  // ── Per-frame-step daily changes (i ≥ 1). ΔOAS in DECIMAL (÷100) so −1/coef(r_HYG) is in
  //    years directly. Log returns per instrument. ──
  const stepDate: string[] = [];
  const dOas: number[] = []; // decimal
  const dOasPp: number[] = []; // percentage points, for |ΔOAS| ranking + reporting
  const oasPrevPp: number[] = [];
  const oasNowPp: number[] = [];
  const r: number[][] = [[], ...symbols.map(() => [])]; // r[col][k] log return; col 0 (OAS) unused
  for (let i = 1; i < dates.length; i++) {
    stepDate.push(dates[i]!);
    const dpp = V[COL.OAS]![i]! - V[COL.OAS]![i - 1]!;
    dOasPp.push(dpp);
    dOas.push(dpp / 100);
    oasPrevPp.push(V[COL.OAS]![i - 1]!);
    oasNowPp.push(V[COL.OAS]![i]!);
    for (let col = 1; col <= symbols.length; col++) {
      r[col]!.push(Math.log(V[col]![i]! / V[col]![i - 1]!));
    }
  }

  const fitIdx: number[] = [];
  const scoreIdx: number[] = [];
  for (let k = 0; k < stepDate.length; k++) {
    const dt = stepDate[k]!;
    if (dt >= CLIP_START && dt <= FIT_END) fitIdx.push(k);
    else if (dt >= SCORE_START && dt <= TODAY) scoreIdx.push(k);
  }

  console.log(`═══ same-day HY-OAS nowcast fit probe — target ${target.key} ═══`);
  console.log(
    `FRED series      : ${FRED_SERIES} (${target.stitchVintage ? "vintage ⊕ live tail" : "live tail only"}; stitch warnings: ${warnings.length})`,
  );
  console.log(`Prices (deep)    : ${symbols.join(" ")}  (adjusted closes, log returns)`);
  console.log(`Clip window      : ${CLIP_START} → ${TODAY}`);
  console.log(`First aligned    : ${firstAligned}   (P8 — ${target.price} inception may bind above ${CLIP_START})`);
  console.log(`Last aligned     : ${lastAligned}`);
  console.log(`Frame rows       : ${dates.length}  → ${stepDate.length} daily steps`);
  console.log(`FIT   window     : ${CLIP_START} → ${FIT_END}   rows=${fitIdx.length}`);
  console.log(`SCORE window     : ${SCORE_START} → ${TODAY}   rows=${scoreIdx.length}`);
  console.log(
    `Decision bar     : tail sign agreement ≥ ${TAIL_PASS_BAR}/${TAIL_SIZE}` +
      (target.reactBand ? ` AND rev-fit tail react ∈ [${target.reactBand[0]}, ${target.reactBand[1]}]` : ""),
  );
  console.log("");

  if (fitIdx.length < 100 || scoreIdx.length < TAIL_SIZE) {
    console.log(`⚠ thin data: fit=${fitIdx.length} score=${scoreIdx.length} — results below may be unreliable.`);
  }

  // Tail subset (P4): worst |ΔOAS| within the score window.
  const tailIdx = [...scoreIdx]
    .sort((a, b) => Math.abs(dOasPp[b]!) - Math.abs(dOasPp[a]!))
    .slice(0, TAIL_SIZE);
  const tailN = tailIdx.length;
  const tailMinMovePp = tailN ? Math.abs(dOasPp[tailIdx[tailN - 1]!]!) : 0;

  type Result = {
    arm: string;
    beta: number | null;
    durYears: number;
    durYearsRev: number;
    rmsePp: number;
    signFull: number;
    signFullN: number;
    tailAgree: number;
    tailWorstPp: number;
    reactRev: number;
    pass: boolean;
    warns: string[];
  };
  const results: Result[] = [];
  const DIMSON_LAGS = 2;
  const candidates: string[] = [];

  for (const arm of ARMS) {
    // Fit on the FIT window only.
    const y = fitIdx.map((k) => dOas[k]!);
    const xHyg = fitIdx.map((k) => r[COL.PRICE]![k]!);
    const cols = arm.hedge === null ? [xHyg] : [xHyg, fitIdx.map((k) => r[arm.hedge!]![k]!)];
    const coef = olsThroughOrigin(cols, y);
    const coefHyg = coef[0]!;
    const durYears = -1 / coefHyg;
    const beta = arm.hedge === null ? null : coef[1]! * durYears; // = coef(r_hedge)·HY_SPREAD_DURATION

    // ── U1 (Addendum A): close the errors-in-variables bracket. ──
    // The forward fit above puts the RETURN on the regressor side. Daily HYG returns carry ETF
    // premium/discount and stale-mark noise, which attenuates coef(r) toward zero and so INFLATES
    // durYears = −1/coef: the forward fit is an UPPER bound on the true spread duration. The
    // reverse fit below swaps the sides — it regresses the arm's excess return ON ΔOAS, so its
    // slope is −D directly and is a LOWER bound. Classical EIV puts the truth between the two.
    // Both fits read the FIT window ONLY (P2); nothing here touches the score window.
    // The probe applies NO ruling — it reports the bracket, S2 adopts its LOWER end per U1.
    const excessFit = fitIdx.map((k, i) =>
      arm.hedge === null ? xHyg[i]! : xHyg[i]! - beta! * r[arm.hedge]![k]!,
    );
    const durYearsRev = -olsThroughOrigin([y], excessFit)[0]!;

    const warns: string[] = [];
    if (durYearsRev > durYears) {
      warns.push(
        `⚠ bracket INVERTED — reverse ${durYearsRev.toFixed(2)}y above forward ${durYears.toFixed(2)}y; ` +
          `classical EIV does not hold here, so neither end bounds the truth`,
      );
    } else if (PUBLISHED !== null && (PUBLISHED < durYearsRev || PUBLISHED > durYears)) {
      warns.push(
        `⚠ published ${PUBLISHED}y is OUTSIDE the bracket ` +
          `[${durYearsRev.toFixed(2)}, ${durYears.toFixed(2)}] — attenuation alone does not explain the gap`,
      );
    }
    if (durYears < DURATION_MIN_YEARS || durYears > DURATION_MAX_YEARS) {
      warns.push(
        `⚠ HY_SPREAD_DURATION ${durYears.toFixed(2)}y outside ` +
          `[${DURATION_MIN_YEARS}, ${DURATION_MAX_YEARS.toFixed(2)}] — RED FLAG`,
      );
    }
    if (beta !== null && Math.abs(beta) > BETA_ABS_MAX) {
      warns.push(`⚠ |β| ${Math.abs(beta).toFixed(2)} above ${BETA_ABS_MAX} — RED FLAG`);
    }

    // Score on the SCORE window only, using the frozen constants.
    let sse = 0;
    let n = 0;
    let signMatchFull = 0;
    const excessOf = (k: number): number =>
      arm.hedge === null ? r[COL.PRICE]![k]! : r[COL.PRICE]![k]! - beta! * r[arm.hedge]![k]!;
    const errAt = (k: number): { err: number; match: boolean } => {
      const excess = excessOf(k);
      const oasEst = oasPrevPp[k]! - (excess / durYears) * 100; // N3: minus the sum
      const err = oasEst - oasNowPp[k]!;
      const predDir = sign(oasEst - oasPrevPp[k]!);
      const actDir = sign(oasNowPp[k]! - oasPrevPp[k]!);
      return { err, match: predDir === actDir };
    };
    for (const k of scoreIdx) {
      const { err, match } = errAt(k);
      sse += err * err;
      n += 1;
      if (match) signMatchFull += 1;
    }
    const rmsePp = Math.sqrt(sse / n);

    let tailAgree = 0;
    let tailWorstPp = 0;
    for (const k of tailIdx) {
      const { err, match } = errAt(k);
      if (match) tailAgree += 1;
      tailWorstPp = Math.max(tailWorstPp, Math.abs(err));
    }
    let reactRev = NaN;

    // Candidate-D table for the U1 re-ask: Dimson lag-sum fit (FIT window) + each D scored on SCORE.
    const lagFit = fitIdx.filter((k) => k >= DIMSON_LAGS);
    const lagCols = Array.from({ length: DIMSON_LAGS + 1 }, (_, l) => lagFit.map((k) => excessOf(k - l)));
    const durDimson = -1 / olsThroughOrigin(lagCols, lagFit.map((k) => dOas[k]!)).reduce((a, b) => a + b, 0);
    const dSources: [string, number][] = [
      ["fwd", durYears],
      ["rev", durYearsRev],
      ...(PUBLISHED === null ? [] : ([["published", PUBLISHED]] as [string, number][])),
      [`dimson(${DIMSON_LAGS})`, durDimson],
    ];
    for (const [name, d] of dSources) {
      const predPp = (k: number): number => -(excessOf(k) / d) * 100;
      const sq = (ks: number[]): number => ks.reduce((a, k) => a + (predPp(k) - dOasPp[k]!) ** 2, 0);
      const react =
        tailIdx.reduce((a, k) => a + predPp(k) * dOasPp[k]!, 0) / tailIdx.reduce((a, k) => a + dOasPp[k]! ** 2, 0);
      const worst = Math.max(...tailIdx.map((k) => Math.abs(predPp(k) - dOasPp[k]!)));
      if (name === "rev") reactRev = react;
      candidates.push(
        `${arm.label.padEnd(22)} ${name.padEnd(10)} ${d.toFixed(2).padStart(6)}  ` +
          `${Math.sqrt(sq(scoreIdx) / scoreIdx.length).toFixed(4).padStart(8)}  ` +
          `${Math.sqrt(sq(tailIdx) / tailN).toFixed(4).padStart(8)}  ${worst.toFixed(4).padStart(8)}  ${react.toFixed(2).padStart(6)}`,
      );
    }

    const band = target.reactBand;
    const pass = tailAgree >= TAIL_PASS_BAR && (band === null || (reactRev >= band[0] && reactRev <= band[1]));

    results.push({
      arm: arm.label,
      beta,
      durYears,
      durYearsRev,
      rmsePp,
      signFull: signMatchFull,
      signFullN: n,
      tailAgree,
      tailWorstPp,
      reactRev,
      pass,
      warns,
    });
  }

  // ── P8 report table. ──
  console.log(`Tail subset      : worst ${tailN} |ΔOAS| days in score window (min move ${tailMinMovePp.toFixed(3)} pp)`);
  console.log("");
  const h =
    `arm                    β     dur_fwd  dur_rev   RMSE(pp)  signFull        tail(/${TAIL_SIZE})  PASS?  worst|err|(pp)  react(rev)`;
  console.log(h);
  console.log("-".repeat(h.length));
  for (const r0 of results) {
    const betaStr = r0.beta === null ? "  —   " : r0.beta.toFixed(3).padStart(6);
    const full = `${r0.signFull}/${r0.signFullN} (${((100 * r0.signFull) / r0.signFullN).toFixed(1)}%)`;
    const tail = `${r0.tailAgree}/${tailN}`;
    console.log(
      `${r0.arm.padEnd(22)} ${betaStr}  ${r0.durYears.toFixed(2).padStart(6)}  ` +
        `${r0.durYearsRev.toFixed(2).padStart(6)}  ` +
        `${r0.rmsePp.toFixed(4).padStart(8)}  ${full.padEnd(15)} ${tail.padStart(9)}  ` +
        `${(r0.pass ? "PASS" : "FAIL").padEnd(5)}  ${r0.tailWorstPp.toFixed(4).padStart(8)}  ${r0.reactRev.toFixed(2).padStart(12)}`,
    );
  }
  console.log("");
  for (const r0 of results) for (const w of r0.warns) console.log(`  [${r0.arm.trim().slice(0, 5)}] ${w}`);

  // ── U1 bracket report (Addendum A). Reported, never applied — S2 adopts the lower end. ──
  console.log("");
  console.log(`═══ U1 EIV BRACKET (published effective duration ${PUBLISHED === null ? "none read" : `${PUBLISHED}y`}) ═══`);
  for (const r0 of results) {
    const inside = PUBLISHED !== null && PUBLISHED >= r0.durYearsRev && PUBLISHED <= r0.durYears;
    console.log(
      `${r0.arm.padEnd(22)} D ∈ [${r0.durYearsRev.toFixed(2)}, ${r0.durYears.toFixed(2)}] y  ` +
        `→ S2 would adopt ${r0.durYearsRev.toFixed(2)}y  ` +
        (PUBLISHED === null ? "" : `(published ${inside ? "INSIDE" : "OUTSIDE"} the bracket)`),
    );
  }

  console.log("");
  console.log("═══ CANDIDATE D (score window; react = tail slope of predicted on actual ΔOAS, 1.00 = right-sized) ═══");
  console.log("arm                    D-source    D(y)   RMSE(pp)  tailRMSE  worst|err|  react");
  for (const line of candidates) console.log(line);

  // ── P5 verdict — the probe applies NO ruling beyond printing this. ──
  const passers = results.filter((r0) => r0.pass).map((r0) => r0.arm.trim());
  console.log("");
  console.log(`═══ VERDICT (tail sign agreement ≥ ${TAIL_PASS_BAR}/${TAIL_SIZE}${target.reactBand ? " AND react band" : ""}) ═══`);
  if (passers.length === 0) {
    console.log("NO ARM PASSES — negative result for this target. No lane ships.");
  } else {
    console.log(`PASSING ARM(S): ${passers.join(", ")}`);
  }
  console.log("(Measurement only — no registry edit, no src/ change, no lane. Open [USER] rungs are unresolved.)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
