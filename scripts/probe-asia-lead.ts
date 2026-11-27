/**
 * Asia channel — does a Korea-derived detector lead US semis? (Stage 0 decision gate)
 *
 * Plan archived 2026-08-20 — the gate fired.
 *
 * Thin entry point over the parametrized core (`probe-db-lead-core.ts`), the same shape as
 * `probe-db-smh-lead.ts`. Method + the FROZEN B3 rule live in the core docblock and are REUSED
 * verbatim here — this probe invents no threshold of its own. REPORT ONLY: it applies no ruling,
 * ships no registry row, and changes nothing production emits.
 *
 * ── QUESTION (pre-registered) ────────────────────────────────────────────────────
 *   Does the downside-break detector applied to KOREA (EWY) confirm a real SMH downturn EARLIER
 *   than the SAME detector applied to SMH itself (DB_SMH), without firing more false positives?
 *
 *   BASELINE = DB_SMH — the user's "beat-the-self" choice (questions round, 2026-08-20). Korea must
 *   beat SMH's own detector on the same episodes, not merely correlate with SMH. This is the strict
 *   test: it kills a "Korea predicts semis" finding that is really just "semis trend".
 *
 *   MASTER = SMH adjusted closes. Episodes are pure price geometry on the thing being PREDICTED, so
 *   they reference neither detector and neither can predict itself.
 *
 *   Detector and baseline run the IDENTICAL transform (`downsideBreakReadingSeries`) under the
 *   IDENTICAL cut pair — `downsideCuts` returns the DB_SMH defaults for any id absent from
 *   `DOWNSIDE_CUT_OVERRIDES` (only DB_XLK is in that table), so the probe-local `EWY_BREAK` /
 *   `EWY_EEM_BREAK` ids resolve to exactly DB_SMH's cuts. The ONLY thing varying across the
 *   comparison is WHICH MARKET is read. Do not declare a `backfill` depth on these ids.
 *
 * ── TWO ARMS (the confound) ──────────────────────────────────────────────────────
 *   EWY in USD carries KRW FX + generic Korea/EM beta, not just the memory cycle. A raw-EWY lead
 *   could be a dollar signal wearing a semis hat — an axis `F9 Broad USD` already covers.
 *
 *     Arm A — EWY raw adjusted closes. The headline read.
 *     Arm B — the EWY/EEM ratio, stripping generic EM beta so what survives is Korea-specific.
 *
 *   ⚠ PRE-REGISTERED READING RULE: **Arm B is the load-bearing result.** A passing while B fails
 *   means the lead IS EM/dollar beta → treat the whole probe as a FAIL and do not promote. Recording
 *   this here, before the run, is the point: it cannot be relaxed after seeing the numbers.
 *
 * ── THE GATE ─────────────────────────────────────────────────────────────────────
 *   Arm B fails B3 ⇒ the plan CLOSES at Stage 0: record the null in `docs/reference.md` §[live],
 *   archive the plan, stop. No re-run at a looser threshold.
 *
 *   ⛔ IT FIRED. Run 2026-08-20: median lead **0.0 trading days in BOTH arms** — Korea confirms the
 *   SAME DAY as SMH, so the channel is COINCIDENT, not leading; both arms FAIL, robustly across the
 *   whole X sweep. The FP tax is NEGATIVE (−0.15 / −1.80 per yr): Korea is *quieter*, not *earlier*.
 *   `EWY` is UNWIRED and stays that way. This file is kept as the runnable falsifier behind the
 *   `docs/reference.md` §[live] closure row — do NOT re-research the channel; re-run this instead.
 *
 * Usage:
 *   npx tsx scripts/probe-asia-lead.ts
 *   npx tsx scripts/probe-asia-lead.ts -- --json=/tmp/asia-lead.json
 */
import type { Indicator, Observation } from "../src/domain-types.js";
import { DB_SMH } from "../src/registry-price.js";
import { alignByDate } from "../src/scorers-core.js";
import { downsideBreakReadingSeries } from "../src/scorers-price.js";
import { loadCloses, runProbe } from "./probe-db-lead-core.js";

const SMH_FIXTURE = "scripts/backtest/data/smh_adj.csv"; // master + baseline (adjusted, as DB_SMH's live feed)
const EWY_FIXTURE = "scripts/backtest/data/ewy.csv"; // Korea (adjusted, unwired — Stage-0 only)
const EEM_FIXTURE = "scripts/backtest/data/eem.csv"; // Arm B denominator (adjusted, same vendor basis)

const smh = loadCloses(SMH_FIXTURE);
const ewy = loadCloses(EWY_FIXTURE);
const eem = loadCloses(EEM_FIXTURE);

/** Probe-local DB_* descriptor. NOT a registry row and never exported — Stage 0 ships no indicator,
 *  so a null result costs nothing to unwind. `id` stays out of `DOWNSIDE_CUT_OVERRIDES` on purpose
 *  (see docblock): that is what makes it inherit DB_SMH's cuts. */
const probeDetector = (id: string, label: string): Indicator => ({
  ...DB_SMH,
  id,
  label,
  longLabel: `Downside break - ${label} (probe-local, DB_SMH cuts)`,
});

/** EWY÷EEM as an Observation[] on the intersected trading-day axis — the EM-beta-stripped arm. */
function ratio(num: Observation[], den: Observation[]): Observation[] {
  const { dates, a, b } = alignByDate(num, den);
  const out: Observation[] = [];
  for (let i = 0; i < dates.length; i++) {
    const d = b[i]!;
    if (!Number.isFinite(d) || d === 0) continue; // a zero/absent denominator is a hole, not a value
    out.push({ date: dates[i]!, value: a[i]! / d });
  }
  return out;
}

const ewyEem = ratio(ewy, eem);

console.log(
  `\n[fixtures] SMH ${smh.length} closes ${smh[0]?.date}→${smh.at(-1)?.date} | ` +
    `EWY ${ewy.length} ${ewy[0]?.date}→${ewy.at(-1)?.date} | ` +
    `EWY/EEM ${ewyEem.length} ${ewyEem[0]?.date}→${ewyEem.at(-1)?.date}`,
);

const baselineReadings = downsideBreakReadingSeries(DB_SMH, smh);

console.log("\n════ ARM A — EWY raw (headline; carries KRW/EM beta) ════");
runProbe({
  detectorId: "EWY_BREAK",
  baselineId: "DB_SMH",
  masterLabel: "SMH",
  master: smh,
  detectorReadings: downsideBreakReadingSeries(probeDetector("EWY_BREAK", "EWY"), ewy),
  baselineReadings,
  wiringNote: "Stage 1, separate session",
  ruleNote: "reused verbatim from DB_SMH — no re-tune",
});

console.log("\n════ ARM B — EWY/EEM (EM beta stripped; LOAD-BEARING) ════");
runProbe({
  detectorId: "EWY_EEM_BREAK",
  baselineId: "DB_SMH",
  masterLabel: "SMH",
  master: smh,
  detectorReadings: downsideBreakReadingSeries(probeDetector("EWY_EEM_BREAK", "EWY/EEM"), ewyEem),
  baselineReadings,
  wiringNote: "Stage 1, separate session",
  ruleNote: "reused verbatim from DB_SMH — no re-tune",
});

console.log(
  "\n[gate] Arm B is the verdict. A-pass + B-fail ⇒ the lead is EM/dollar beta (F9 covers it) ⇒ FAIL.\n",
);
