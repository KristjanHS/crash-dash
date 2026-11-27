/**
 * FDX direction falsifier — Stage 2 seat gate for the TSM÷SMH foundry-dependency leg.
 *
 * Thin wrapper over the parametrized core (`probe-db-lead-core.ts`), the `probe-db-smh-lead.ts`
 * precedent. Method, the frozen B3 rule, the D/X sweeps and the placebo arms live in the core
 * docblock. REPORT ONLY — the seat / keep-chart-only call is a separate `[USER]` round, Stage 2 of
 * the AVGO leading-legs work. This file wires nothing.
 *
 * ── QUESTION (pre-registered) ────────────────────────────────────────────────────
 *   The plan seats `FDX` only if its confirmed-RED days mark FOUNDRY stress that reaches AVGO —
 *   not fabless outperformance, which drives TSM÷SMH down for the opposite reason. Those are the
 *   core's two existing axes, so no new estimator is needed:
 *     · "clusters with the drawdowns"  → episode hit + median LEAD vs the baseline
 *     · "clusters with fabless rallies" → the FALSE-POSITIVE rate (fires outside every episode)
 *   Fabless-rally REDs land off-episode by construction, so a leg that is really reading rotation
 *   rather than stress shows up as an FP tax, not as lead.
 *
 * ── GROUND TRUTH IS AVGO, NOT SMH (ruled 2026-08-29, addendum 2) ─────────────────
 *   The plan body says "cluster with semis drawdowns", but SMH is FDX's own DENOMINATOR and holds
 *   AVGO itself — an SMH master would score the detector partly against its own input. The leg
 *   exists to lead AVGO's order-book stress, so AVGO's own peak→trough episodes are the honest
 *   master. That supersedes the plan body's wording.
 *
 *   Baseline = F4 semis (`semisReadingSeries(F4, smh, nvda)`): the slow semis-wide comparator, so a
 *   PASS means FDX beat "just watch semis", which is the only reading that justifies its own seat.
 *
 * ⚠ FIXTURES ARE CLOSES-PROVIDER-SOURCED AND FROZEN (the offline fetcher regenerates them). A
 *   live fetch here would move the table run-to-run and no seat ruling could be re-derived.
 *
 * Usage:
 *   npm run probe:fdx-direction
 *   npm run probe:fdx-direction -- --json=/tmp/fdx-direction.json
 */
import { F4 } from "../src/registry-price.js";
import { FDX } from "../src/registry-composite.js";
import { ratioVsMaReadingSeries, semisReadingSeries } from "../src/scorers-price.js";
import { loadCloses, runProbe } from "./probe-db-lead-core.js";

const AVGO_FIXTURE = "scripts/backtest/data/avgo_adj.csv"; // MASTER — the episode axis
const TSM_FIXTURE = "scripts/backtest/data/tsm_adj.csv"; // FDX numerator
const SMH_FIXTURE = "scripts/backtest/data/smh_adj.csv"; // FDX denominator + F4's master
const NVDA_FIXTURE = "scripts/backtest/data/nvda_adj.csv"; // F4's second gate input (NVDA<MA200)

const avgo = loadCloses(AVGO_FIXTURE);
const tsm = loadCloses(TSM_FIXTURE);
const smh = loadCloses(SMH_FIXTURE);
const nvda = loadCloses(NVDA_FIXTURE);

runProbe({
  detectorId: "FDX",
  baselineId: "F4",
  masterLabel: "AVGO",
  master: avgo,
  detectorReadings: ratioVsMaReadingSeries(FDX, tsm, smh),
  baselineReadings: semisReadingSeries(F4, smh, nvda),
  wiringNote: "Stage 2, separate USER round",
  ruleNote: "reused unchanged from the DB_* gate",
});
