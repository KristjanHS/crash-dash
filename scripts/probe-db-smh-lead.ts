/**
 * DB_SMH lead / false-positive backtest — Part B decision gate (SMH entry point).
 *
 * Thin wrapper over the parametrized core (`probe-db-lead-core.ts`): loads the offline SMH/NVDA
 * fixtures, computes the prod detector + baseline reading series, and hands them to `runProbe`.
 * Method + frozen B3 rule live in the core docblock. REPORT ONLY — the promote/keep-display-only
 * call (B3) is a separate USER round; wiring is a separate session.
 *
 * ── QUESTION (B, pre-registered) ─────────────────────────────────────────────────
 *   Does DB_SMH (drawdown-from-63d-high, gated by MA50; Amber −8% / Red −15% AS MEASURED here —
 *   retuned to −5/−8 on 2026-07-23, so a re-run scores a strictly earlier-firing detector) confirm a real SMH
 *   downturn EARLIER than F4 (SMH 6-mo return vs MA200, compound-gated by NVDA<MA200), WITHOUT
 *   firing more false positives? If not, DB_SMH stays display-only.
 *
 *   Baseline = F4 semis (`semisReadingSeries(F4, smh, nvda)` — NVDA<MA200 is F4's second gate input).
 *
 * Usage:
 *   npx tsx scripts/probe-db-smh-lead.ts
 *   npx tsx scripts/probe-db-smh-lead.ts --json=/tmp/db-smh-lead.json
 */
import { DB_SMH, F4 } from "../src/registry-price.js";
import { downsideBreakReadingSeries, semisReadingSeries } from "../src/scorers-price.js";
import { loadCloses, runProbe } from "./probe-db-lead-core.js";

const SMH_FIXTURE = "scripts/backtest/data/smh_adj.csv";
const NVDA_FIXTURE = "scripts/backtest/data/nvda_adj.csv"; // F4's second gate input (NVDA<MA200)

const smh = loadCloses(SMH_FIXTURE);
const nvda = loadCloses(NVDA_FIXTURE);

runProbe({
  detectorId: "DB_SMH",
  baselineId: "F4",
  masterLabel: "SMH",
  master: smh,
  detectorReadings: downsideBreakReadingSeries(DB_SMH, smh),
  baselineReadings: semisReadingSeries(F4, smh, nvda),
  wiringNote: "B5, separate session",
  ruleNote: "loosened pre-run",
});
