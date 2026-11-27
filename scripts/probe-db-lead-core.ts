/**
 * Downside-break lead / false-positive backtest — PARAMETRIZED CORE (Part B decision gate).
 *
 * This is the MEASUREMENT engine shared by the per-detector entry points
 * (`probe-db-smh-lead.ts`, `probe-db-nvda-lead.ts`, …). It REPORTS numbers + a PASS/FAIL against
 * the frozen B3 rule and STOPS at the verdict — it applies NO ruling and changes NOTHING production
 * emits. The promote/keep-display-only call (B3) is a separate USER round; wiring is a separate session.
 *
 * A `ProbeSpec` names the detector (`DB_*`, the fast 63d-drawdown detector) and its SLOW baseline
 * comparator (F4 semis for SMH; the NVDA/QQQ MA200 gate for the singles), plus the underlying-price
 * MASTER axis those readings live on. The core is detector-agnostic: it consumes pre-computed
 * `Reading[]` from prod scorers and never re-derives what it tests.
 *
 * ── FROZEN B3 RULE (pre-registered; identical across every detector — a REUSE, not a re-tune) ─────
 *   Promote iff ALL THREE hold:
 *     1. median real Lead ≥ +3 trading days
 *     2. FP(detector) − FP(baseline) ≤ +2 per year
 *     3. real median lead beats EVERY placebo arm by ≥ 3 trading days
 *   Fail any one ⇒ stays display-only. No post-hoc movement.
 *
 * ── GROUND TRUTH — episodes (B1, INDEPENDENT of both detectors, so neither can predict itself) ───
 *   Episode = a peak-to-trough decline ≥ D% in the MASTER (underlying) price — pure price geometry
 *   (references neither MA50 nor MA200). onset = the last peak before the trough. A leg ENDS when
 *   close recovers ≥ X% off its trough. Sweep D ∈ {15,20,25} (D=20 primary) and recover X ∈
 *   {15,20,25} (X=20 primary); the verdict must hold across the WHOLE X sweep (anti-overfit).
 *   Lead(episode) = baseline_confirm_idx − detector_confirm_idx in trading days, where BOTH
 *   first-confirmed-RED dates fall in [onset−20d, trough]. Positive ⇒ the detector is earlier.
 *   False positive = a confirmed-RED FIRE EVENT (off→on transition) whose date is NOT inside any
 *   episode's [onset−20d, trough] window. Counted for BOTH over the identical span; the metric is
 *   the per-year DIFFERENCE.
 *
 * ── PLACEBO (B2) ─────────────────────────────────────────────────────────────────────────────────
 *   Shift detector confirmed-RED dates FORWARD N trading days (same count, same clustering, wrong
 *   dates; sweep N ∈ {40,80,120}) and recompute median lead. Printed real-vs-placebo side by side.
 *
 * ── DISCIPLINE (B4) ──────────────────────────────────────────────────────────────────────────────
 *   Imports PRODUCTION scorers (via the entry points) — never reimplements what it tests. OFFLINE
 *   (committed CSV fixtures), strictly READ-ONLY: no feed/data/calibration write. Optional
 *   `--json=<path>` machine dump, guarded by assertSafeJsonPath.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Observation, Reading, State } from "../src/domain-types.js";
import { assertSafeJsonPath } from "./backtest/drift-guard.js";
import { medianOrNull } from "./lib/stats.js";

const D_SWEEP = [15, 20, 25] as const; // episode threshold %; D=20 primary
const D_PRIMARY = 20;
// Recover-X%-off-the-low episode segmentation: an episode ENDS when close rises ≥ X% above its
// trough — NOT on recover-to-prior-peak, which merges a secular decline into one vacuously-wide
// episode. X is a knob, so it is SWEPT and the verdict must hold across the whole sweep
// (anti-overfit) — never tuned to force a pass.
const RECOVERY_SWEEP = [15, 20, 25] as const; // % above trough that closes an episode; X=20 primary
const RECOVERY_PRIMARY = 20;
const PLACEBO_N = [40, 80, 120] as const; // forward-shift trading days
const ONSET_LOOKBACK = 20; // window opens 20 trading days before onset
const FP_HORIZON = 60; // H (trading days) — documented; episode windows already encode it
const TRADING_DAYS_PER_YEAR = 252;

// Frozen B3 rule (identical across every detector) -----------------------------
const RULE_MIN_LEAD = 3; // bar 1: median lead ≥ +3 td
const RULE_MAX_FP_TAX = 2; // bar 2: FP(detector) − FP(baseline) ≤ +2 / yr
const RULE_PLACEBO_MARGIN = 3; // bar 3: real median lead beats every placebo by ≥ 3 td

/** What a per-detector entry point hands the core: labels, the master axis, and prod readings. */
export interface ProbeSpec {
  detectorId: string; // e.g. "DB_SMH" — headline + table labels
  baselineId: string; // e.g. "F4" / "NVDA gate" — the SLOW comparator the lead is measured against
  masterLabel: string; // e.g. "SMH" — the underlying series name (for the "N closes" line)
  master: Observation[]; // detector underlying closes — DEFINES the trading-day axis + episodes
  detectorReadings: Reading[]; // downsideBreakReadingSeries(DB_*, master), from prod
  baselineReadings: Reading[]; // the SLOW baseline reading series, from prod (same master axis)
  wiringNote?: string; // the PASS-line wiring-session label; defaults to "separate session"
  ruleNote?: string; // frozen-rule-line provenance (e.g. DB_SMH's "loosened pre-run"); omit ⇒ plain "Frozen B3 rule"
}

// --- fixture load (date,value CSV → Observation[], oldest→newest) --------------
export function loadCloses(fixture: string): Observation[] {
  const out: Observation[] = [];
  for (const raw of readFileSync(fixture, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("date")) continue;
    const [date, v] = line.split(",");
    const value = Number(v);
    if (!date || !Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// --- ground-truth episodes (peak→trough ≥ D%, pure price geometry) -------------
interface Episode {
  onsetDate: string;
  troughDate: string;
  onsetIdx: number; // master trading-day index of the pre-trough peak
  troughIdx: number;
  ddPct: number; // peak→trough decline, negative %
}

function extractEpisodes(closes: Observation[], dPct: number, recoveryPct: number): Episode[] {
  const thresh = -dPct / 100;
  const recover = 1 + recoveryPct / 100; // close ≥ troughVal * recover ⇒ episode ends
  const eps: Episode[] = [];
  let peakVal = closes[0]!.value,
    peakIdx = 0,
    troughVal = closes[0]!.value,
    troughIdx = 0,
    inDD = false;
  const flush = () => {
    if (inDD && troughVal / peakVal - 1 <= thresh) {
      eps.push({
        onsetDate: closes[peakIdx]!.date,
        troughDate: closes[troughIdx]!.date,
        onsetIdx: peakIdx,
        troughIdx,
        ddPct: (troughVal / peakVal - 1) * 100,
      });
    }
  };
  // recover-X%-off-the-low segmentation: a leg ends when close climbs ≥ X% above its trough, then a
  // fresh peak-search starts from that recovery point (so a secular decline splits into its legs).
  const reset = (i: number, v: number) => {
    peakVal = v;
    peakIdx = i;
    troughVal = v;
    troughIdx = i;
    inDD = false;
  };
  for (let i = 1; i < closes.length; i++) {
    const v = closes[i]!.value;
    if (!inDD) {
      if (v >= peakVal) {
        peakVal = v; // extend the running peak (no drawdown open yet)
        peakIdx = i;
      } else {
        inDD = true; // first close below the peak opens a drawdown
        troughVal = v;
        troughIdx = i;
      }
      continue;
    }
    if (v < troughVal) {
      troughVal = v;
      troughIdx = i;
    }
    if (v >= troughVal * recover) {
      flush(); // recovered ≥ X% off the low → close any qualifying episode, restart the search here
      reset(i, v);
    }
  }
  flush(); // an unrecovered drawdown at series end still counts
  return eps;
}

// --- confirmed-state → per-day boolean on the master trading-day axis -----------
type AtLeast = "RED" | "AMBER"; // AMBER ⇒ amber-or-worse

function confirmedOn(
  readings: Reading[],
  dateToIdx: Map<string, number>,
  masterLen: number,
  atLeast: AtLeast,
): boolean[] {
  const on = new Array<boolean>(masterLen).fill(false);
  const hit = (s: State) => (atLeast === "RED" ? s === "RED" : s === "RED" || s === "AMBER");
  for (const r of readings) {
    const idx = dateToIdx.get(r.date);
    if (idx !== undefined && hit(r.state)) on[idx] = true;
  }
  return on;
}

function firstOnInWindow(on: boolean[], lo: number, hi: number): number | null {
  for (let i = Math.max(0, lo); i <= Math.min(on.length - 1, hi); i++) if (on[i]) return i;
  return null;
}

/** Fire EVENTS = off→on transitions (a detector holds RED for many days; count events, not days). */
function fireEvents(on: boolean[]): number[] {
  const ev: number[] = [];
  for (let i = 0; i < on.length; i++) if (on[i] && !(i > 0 && on[i - 1])) ev.push(i);
  return ev;
}

function inAnyWindow(idx: number, episodes: Episode[]): boolean {
  return episodes.some((e) => idx >= e.onsetIdx - ONSET_LOOKBACK && idx <= e.troughIdx);
}

function countFP(on: boolean[], episodes: Episode[]): number {
  return fireEvents(on).filter((i) => !inAnyWindow(i, episodes)).length;
}

/** Shift a confirmed-on series FORWARD n trading days (placebo: wrong dates, same count+clustering). */
function shiftForward(on: boolean[], n: number): boolean[] {
  const out = new Array<boolean>(on.length).fill(false);
  for (let i = 0; i < on.length; i++) if (on[i] && i + n < on.length) out[i + n] = true;
  return out;
}

// --- per-episode lead (both detectors must confirm inside the window) ----------
interface LeadRow {
  onsetDate: string;
  troughDate: string;
  ddPct: number;
  dbConfirmDate: string | null;
  baseConfirmDate: string | null;
  lead: number | null; // baseIdx − dbIdx (trading days); positive ⇒ the detector is earlier
}

function leadRows(
  episodes: Episode[],
  dbOn: boolean[],
  baseOn: boolean[],
  masterDates: string[],
): LeadRow[] {
  return episodes.map((e) => {
    const lo = e.onsetIdx - ONSET_LOOKBACK;
    const hi = e.troughIdx;
    const dbIdx = firstOnInWindow(dbOn, lo, hi);
    const baseIdx = firstOnInWindow(baseOn, lo, hi);
    return {
      onsetDate: e.onsetDate,
      troughDate: e.troughDate,
      ddPct: e.ddPct,
      dbConfirmDate: dbIdx === null ? null : masterDates[dbIdx]!,
      baseConfirmDate: baseIdx === null ? null : masterDates[baseIdx]!,
      lead: dbIdx === null || baseIdx === null ? null : baseIdx - dbIdx,
    };
  });
}

function medianLead(rows: LeadRow[]): number | null {
  return medianOrNull(rows.filter((r) => r.lead !== null).map((r) => r.lead!));
}

// --- one full gate evaluation over a given episode set (lead + FP tax + placebo + 3 bars) --------
interface GateEval {
  rows: LeadRow[];
  medLead: number | null;
  bothN: number;
  fpDb: number;
  fpBase: number;
  fpTax: number;
  placebo: { n: number; med: number | null; margin: number | null }[];
  bar1: boolean;
  bar2: boolean;
  bar3: boolean;
  pass: boolean;
}

function evaluateGate(
  episodes: Episode[],
  dbRed: boolean[],
  baseRed: boolean[],
  masterDates: string[],
  spanYears: number,
): GateEval {
  const rows = leadRows(episodes, dbRed, baseRed, masterDates);
  const medLead = medianLead(rows);
  const bothN = rows.filter((r) => r.lead !== null).length;
  const fpDb = countFP(dbRed, episodes);
  const fpBase = countFP(baseRed, episodes);
  const fpTax = fpDb / spanYears - fpBase / spanYears;
  const placebo = PLACEBO_N.map((n) => {
    const med = medianLead(leadRows(episodes, shiftForward(dbRed, n), baseRed, masterDates));
    return { n, med, margin: medLead === null || med === null ? null : medLead - med };
  });
  const bar1 = medLead !== null && medLead >= RULE_MIN_LEAD;
  const bar2 = fpTax <= RULE_MAX_FP_TAX;
  // fail-loud: a null placebo margin is ABSENCE of evidence — the real or placebo median lead was
  // uncomputable — never a vacuous "no fake lead to beat" pass. bar3 requires a non-empty set of
  // placebo arms, ALL with a real, ≥-margin value.
  const bar3 =
    medLead !== null &&
    placebo.length > 0 &&
    placebo.every((p) => p.margin !== null && p.margin >= RULE_PLACEBO_MARGIN);
  return { rows, medLead, bothN, fpDb, fpBase, fpTax, placebo, bar1, bar2, bar3, pass: bar1 && bar2 && bar3 };
}

// --- tiny table printer --------------------------------------------------------
function table(title: string, headers: string[], rows: (string | number)[][]): void {
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const fmt = (cells: (string | number)[]) =>
    cells.map((c, i) => String(c ?? "").padStart(cols[i]!)).join("  ");
  console.log(`\n${title}`);
  console.log(fmt(headers));
  console.log(cols.map((c) => "─".repeat(c)).join("  "));
  for (const r of rows) console.log(fmt(r));
}

const f1 = (n: number | null) => (n === null ? "—" : n.toFixed(1));

// --- parametrized run ----------------------------------------------------------
export function runProbe(spec: ProbeSpec): void {
  const { detectorId, baselineId, masterLabel, master } = spec;
  const jsonArg = process.argv.find((a) => a.startsWith("--json="))?.split("=")[1];
  if (jsonArg) assertSafeJsonPath(jsonArg);

  const masterDates = master.map((o) => o.date);
  const masterLen = masterDates.length;
  const dateToIdx = new Map(masterDates.map((d, i) => [d, i]));
  const spanYears = masterLen / TRADING_DAYS_PER_YEAR;

  // Production scorers (B4): confirmed .state per day, straight from prod (pre-computed by the entry).
  const dbRed = confirmedOn(spec.detectorReadings, dateToIdx, masterLen, "RED");
  const baseRed = confirmedOn(spec.baselineReadings, dateToIdx, masterLen, "RED");
  const dbAmber = confirmedOn(spec.detectorReadings, dateToIdx, masterLen, "AMBER");
  const baseAmber = confirmedOn(spec.baselineReadings, dateToIdx, masterLen, "AMBER");

  console.log("═".repeat(78));
  console.log(`${detectorId} LEAD / FALSE-POSITIVE BACKTEST — Part B (decision gate, REPORT ONLY)`);
  console.log("═".repeat(78));
  console.log(
    `${masterLabel} closes: ${masterLen} (${masterDates[0]}…${masterDates.at(-1)}), ~${spanYears.toFixed(1)}y ` +
      `· offline fixtures · imports prod scorers · read-only`,
  );
  console.log(
    `Frozen B3 rule${spec.ruleNote ? ` (${spec.ruleNote})` : ""}: lead ≥ +${RULE_MIN_LEAD}d · FP tax ≤ +${RULE_MAX_FP_TAX}/yr · ` +
      `placebo margin ≥ ${RULE_PLACEBO_MARGIN}d · H=${FP_HORIZON}d`,
  );

  // Primary arm: D=20, recover X=20, RED confirms.
  const episodesPrimary = extractEpisodes(master, D_PRIMARY, RECOVERY_PRIMARY);
  const g = evaluateGate(episodesPrimary, dbRed, baseRed, masterDates, spanYears);
  const medLeadPrimary = g.medLead;

  table(
    `PRIMARY — episodes D=${D_PRIMARY}% / recover X=${RECOVERY_PRIMARY}%, first CONFIRMED-RED in [onset−${ONSET_LOOKBACK}d, trough]`,
    ["onset", "trough", "dd%", `${detectorId} RED`, `${baselineId} RED`, "lead(d)"],
    g.rows.map((r) => [
      r.onsetDate,
      r.troughDate,
      r.ddPct.toFixed(1),
      r.dbConfirmDate ?? "—",
      r.baseConfirmDate ?? "—",
      r.lead === null ? "—" : (r.lead > 0 ? `+${r.lead}` : String(r.lead)),
    ]),
  );
  console.log(
    `median real Lead = ${f1(medLeadPrimary)} td  (over ${g.bothN}/${g.rows.length} episodes ` +
      `where BOTH detectors confirmed RED in-window; positive ⇒ ${detectorId} earlier)`,
  );

  // False positives (RED fire EVENTS outside any episode window), both detectors, primary D/X.
  table(
    `FALSE POSITIVES — confirmed-RED fire events outside any D=${D_PRIMARY}% / X=${RECOVERY_PRIMARY}% episode window`,
    ["detector", "RED fires", "FP", "FP/yr"],
    [
      [detectorId, fireEvents(dbRed).length, g.fpDb, (g.fpDb / spanYears).toFixed(2)],
      [baselineId, fireEvents(baseRed).length, g.fpBase, (g.fpBase / spanYears).toFixed(2)],
    ],
  );
  console.log(`FP tax  FP(${detectorId}) − FP(${baselineId}) = ${g.fpTax >= 0 ? "+" : ""}${g.fpTax.toFixed(2)} / yr`);

  // Placebo (B2): shift detector RED forward N days, recompute median lead.
  table(
    `PLACEBO — ${detectorId} RED shifted forward N trading days (real median lead vs placebo)`,
    ["N(d)", "placebo median lead", "real median lead", "real − placebo"],
    g.placebo.map((p) => [
      p.n,
      f1(p.med),
      f1(medLeadPrimary),
      p.margin === null ? "—" : (p.margin > 0 ? `+${p.margin.toFixed(1)}` : p.margin.toFixed(1)),
    ]),
  );

  // Robustness rows (NOT the verdict): median lead per D, RED + amber-or-worse secondary; X fixed.
  table(
    `ROBUSTNESS — median lead by episode threshold D (recover X=${RECOVERY_PRIMARY}%; RED primary, AMBER-or-worse secondary)`,
    ["D%", "#episodes", "#both-RED", "median lead RED", "#both-AMBER", "median lead AMBER"],
    D_SWEEP.map((d) => {
      const eps = extractEpisodes(master, d, RECOVERY_PRIMARY);
      const red = leadRows(eps, dbRed, baseRed, masterDates);
      const amb = leadRows(eps, dbAmber, baseAmber, masterDates);
      return [
        d,
        eps.length,
        red.filter((r) => r.lead !== null).length,
        f1(medianLead(red)),
        amb.filter((r) => r.lead !== null).length,
        f1(medianLead(amb)),
      ];
    }),
  );

  // ANTI-OVERFIT: the verdict must hold across the WHOLE recover-X sweep, not ride one lucky X.
  // Re-run the full 3-bar gate per X at primary D; disagreement ⇒ overfit ⇒ FAIL.
  const xEvals = RECOVERY_SWEEP.map((x) => {
    const eps = extractEpisodes(master, D_PRIMARY, x);
    return { x, nEpisodes: eps.length, ...evaluateGate(eps, dbRed, baseRed, masterDates, spanYears) };
  });
  table(
    `ANTI-OVERFIT — full verdict stability across recover threshold X (D=${D_PRIMARY}% fixed)`,
    ["X%", "#episodes", "#both-RED", "median lead", "FP tax/yr", "bar1", "bar2", "bar3", "verdict"],
    xEvals.map((e) => [
      e.x,
      e.nEpisodes,
      e.bothN,
      f1(e.medLead),
      `${e.fpTax >= 0 ? "+" : ""}${e.fpTax.toFixed(2)}`,
      e.bar1 ? "P" : "F",
      e.bar2 ? "P" : "F",
      e.bar3 ? "P" : "F",
      e.pass ? "PASS" : "FAIL",
    ]),
  );
  const allPass = xEvals.every((e) => e.pass);
  const robust = allPass || xEvals.every((e) => !e.pass);
  console.log(
    `verdict is ${robust ? "ROBUST" : "NOT ROBUST"} across X ∈ {${RECOVERY_SWEEP.join(", ")}}% — ` +
      (robust
        ? `every arm agrees (${allPass ? "all PASS" : "all FAIL"})`
        : "arms DISAGREE ⇒ treat as FAIL (a verdict that needs a specific X is overfit)"),
  );

  // Verdict against the FROZEN rule (primary D=20 / X=20, RED). Bars are pre-registered; the
  // promote/keep-display-only call is USER-owned — the probe only reports numbers.
  console.log(`\n${"═".repeat(78)}`);
  console.log("VERDICT (frozen B3 rule, primary D=20% / recover X=20%, RED):");
  console.log(
    `  1. median lead ≥ +${RULE_MIN_LEAD}d ............ ${g.bar1 ? "PASS" : "FAIL"}  (${f1(medLeadPrimary)}d)` +
      `   ⟵ does ${detectorId} warn EARLIER than ${baselineId}?`,
  );
  console.log(
    `  2. FP tax ≤ +${RULE_MAX_FP_TAX}/yr .............. ${g.bar2 ? "PASS" : "FAIL"}  ` +
      `(${g.fpTax >= 0 ? "+" : ""}${g.fpTax.toFixed(2)}/yr)   ⟵ extra false alarms/yr vs ${baselineId} (the "seesaw" cost)`,
  );
  console.log(
    `  3. beats every placebo by ≥ ${RULE_PLACEBO_MARGIN}d .. ${g.bar3 ? "PASS" : "FAIL"}  ` +
      `(margins ${g.placebo.map((p) => (p.margin === null ? "—" : p.margin.toFixed(1))).join(", ")})` +
      `   ⟵ is the lead REAL, or just luck from clustered dates?`,
  );
  console.log(
    `\n  PLAIN READING — bars 1 (leads) + 3 (not a fluke) answer "is the early warning REAL"; bar 2 is\n` +
      `  the false-alarm cost only. All three are FROZEN; the promote/keep-display-only call is YOURS —\n` +
      `  a bar-2 miss with bars 1+3 passing is a false-alarm tradeoff to accept, not a "write it off".`,
  );
  console.log(
    `\n  ⇒ ${detectorId} ${g.pass ? "PASSES" : "FAILS"} the frozen gate` +
      (g.pass ? ` — promotion is USER-owned (${spec.wiringNote ?? "separate session"}).` : " — verdict is USER-owned."),
  );
  console.log("═".repeat(78));
  console.log("Probe REPORTS only — the B3 promotion decision is USER-owned (no wiring changed here).");

  if (jsonArg) {
    const dump = {
      detector: detectorId,
      baseline: baselineId,
      frozenRule: { minLead: RULE_MIN_LEAD, maxFpTaxPerYear: RULE_MAX_FP_TAX, placeboMargin: RULE_PLACEBO_MARGIN, horizonDays: FP_HORIZON },
      span: { closes: masterLen, from: masterDates[0], to: masterDates.at(-1), years: spanYears },
      primary: { dPct: D_PRIMARY, recoveryPct: RECOVERY_PRIMARY, medianLead: g.medLead, episodes: g.rows },
      falsePositives: { db: g.fpDb, base: g.fpBase, dbPerYear: g.fpDb / spanYears, basePerYear: g.fpBase / spanYears, taxPerYear: g.fpTax },
      placebo: g.placebo,
      antiOverfit: {
        recoverySweep: RECOVERY_SWEEP,
        robust,
        arms: xEvals.map((e) => ({ x: e.x, nEpisodes: e.nEpisodes, medLead: e.medLead, fpTax: e.fpTax, bar1: e.bar1, bar2: e.bar2, bar3: e.bar3, pass: e.pass })),
      },
      verdict: { bar1: g.bar1, bar2: g.bar2, bar3: g.bar3, pass: g.pass },
    };
    writeFileSync(jsonArg, JSON.stringify(dump, null, 2));
    console.log(`\nJSON written → ${jsonArg}`);
  }
}
