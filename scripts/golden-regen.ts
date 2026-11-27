/**
 * Stage 0.1 golden-snapshot regen.
 *
 * Deterministic: scores the committed fixture `src/goldens/fixture-observations.json`
 * through the shared dispatch module `src/goldens/dispatch.ts` — the SAME module
 * `src/golden-pins.test.ts` recomputes through, so script and test cannot diverge —
 * and writes `src/goldens/golden-readings.json` (id → serialized reading rows) and
 * `src/goldens/golden-charts.json` (id → buildIndicatorChart spec), sorted keys.
 *
 * Modes:
 *   npx tsx scripts/golden-regen.ts                  # regen snapshots from the committed fixture
 *   npx tsx scripts/golden-regen.ts --write-fixture  # (re)generate the fixture (seeded LCG)
 *   npx tsx scripts/golden-regen.ts --write-fixture --seed 2   # perturb arm (falsifier demo)
 *
 * Rebaseline = run the default mode + commit the diff. NEVER vitest -u (§8).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Observation } from "../src/domain-types.js";
import { oatLegBase } from "../src/scorers-composite.js";
import { BONOS_DESCRIPTOR } from "../src/family-descriptor-rows.js";
import {
  ASOF,
  GOLDENS_DIR,
  FIXTURE_PATH,
  READINGS_PATH,
  CHARTS_PATH,
  computeReadings,
  computeCharts,
  stringifySorted,
} from "../src/goldens/dispatch.js";
import { isoDay } from "../src/dates.js";
import { seriesRand } from "./lib/seeded-lcg.js";

const DAILY_ROWS = 600; // clears CREDIT_WARMUP 252, MA200, HIGH_WINDOW 252, 63d-high, VELOCITY_WINDOW
const WEEKLY_ROWS = 200;
const MONTHLY_ROWS = 90;
/** BONOS's legs (ES10Y + the shared DE10Y) need `oatLegBase(c)` aligned closes before a scored day — deeper
 *  than DAILY_ROWS, so they carry an older PREFIX; the DAILY_ROWS tail stays byte-identical. */
const LEG_LEAD_ROWS = Math.max(0, oatLegBase(BONOS_DESCRIPTOR.scorer.constants) + 30 - DAILY_ROWS);

// --- Fixture generation (--write-fixture only; normal regen READS the committed file) --

type Cadence = "daily" | "weekly" | "monthly";
interface SeriesSpec {
  name: string;
  base: number;
  cadence?: Cadence;
  /** Extra rows generated BEFORE the cadence's tail, off a continuation of the same LCG stream. */
  leadRows?: number;
}

/**
 * Every underlying series/symbol the dispatch table consumes — the fixture's single
 * source. dispatch.ts's `series()` THROWS on a name absent here, so a dispatch entry
 * consuming an undeclared series fails the regen loudly.
 */
const SERIES_SPECS: SeriesSpec[] = [
  // FRED core (INDICATORS loop)
  { name: "BAMLH0A0HYM2", base: 3.5 }, // F1
  { name: "BAMLH0A3HYC", base: 9.0 }, // CCC (scored GLOBAL credit-panel member, %-quoted level)
  { name: "BAMLC0A0CM", base: 1.2 }, // F2
  { name: "NFCIRISK", base: -0.3, cadence: "weekly" }, // F3
  { name: "T10Y3M", base: 0.8 }, // R1 + R7 input
  { name: "NTFS", base: 0.15 }, // R8 (GSW near-term forward spread composite, src/gsw.ts)
  { name: "DGS10", base: 4.0 }, // R2 + R7 input
  { name: "DGS2", base: 4.2 }, // R3 + R7 input
  { name: "DFII10", base: 1.8 }, // R4
  { name: "VIXCLS", base: 18 }, // R5 + slow track + VT front leg + VIX bottom leg (IS-6a repoint)
  { name: "USDU", base: 104 }, // F9
  { name: "BAMLEMCBPIOAS", base: 3.0 }, // F10
  { name: "CNY=X", base: 7.1 }, // F11
  // Proxy + CONTEXT card
  { name: "BAA10Y", base: 1.5 },
  // CQS's second leg. Base is deliberately set so the synthesized Baa−Aaa difference sits clear of
  // BOTH hand-set cuts — the pins then sit off the band and a retune cannot silently move them.
  { name: "AAA10Y", base: 1.1 },
  // Global / confirmer feeds
  { name: "DCOILWTICO", base: 75 }, // G1
  { name: "DCOILBRENTEU", base: 78 }, // BRENT
  { name: "DHHNGSP", base: 3.0 }, // NG (Henry Hub natgas)
  { name: "ebp", base: 0.2, cadence: "monthly" }, // EBP (fetchEbp series)
  { name: "^MOVE", base: 100 }, // R6
  { name: "HG=F", base: 4.2 }, // CG copper
  { name: "GC=F", base: 2300 }, // CG gold
  // VT back leg + VIX3M bottom leg. Front is VIXCLS (base 18) — the two were the closes feed's
  // `^VIX`/`^VIX3M` (bases 17/19) until the 2026-07-26 FRED repoint (IS-6 rung A); base 20
  // keeps the synthetic ratio at ~0.90 contango, the same regime the retired 17/19 pair
  // produced (~0.895), which is below VT's shipped amber cut — so the pins stay off it.
  { name: "VXVCLS", base: 20 },
  { name: "SR_10Y", base: 2.8 }, // EURC
  { name: "SR_3M", base: 3.2 }, // EURC
  { name: "SR_1Y", base: 2.1 }, // EPATH — SR_1Y − ESTR sits below EPATH_DESCRIPTOR.amber (GREEN pin)
  // The sovereign-quote legs: DE10Y is the German leg BONOS and BUND share.
  { name: "DE10Y", base: 2.4, leadRows: LEG_LEAD_ROWS }, // BONOS German leg + BUND's 10y
  { name: "DE2Y", base: 2.7 }, // BUND's 2y — DE10Y − DE2Y ≈ −0.3, below BUND_DESCRIPTOR.amber
  { name: "ES10Y", base: 3.4, leadRows: LEG_LEAD_ROWS }, // BONOS — ~100 bp, ABOVE Spain's own pair (BONOS level RED in the golden)
  { name: "DEXUSEU", base: 1.08 }, // pension FX leg (FRED; FXH left for the closes-feed pairs 2026-08-10)
  { name: "EURUSD=X", base: 1.08 }, // FXH EUR leg
  { name: "CHF=X", base: 0.88 }, // FXH
  { name: "JPY=X", base: 150 }, // FXH
  { name: "ACWI", base: 110 }, // GT
  { name: "FEZ", base: 50 }, // DISP
  { name: "EEM", base: 42 }, // DISP
  { name: "ESTR", base: 2.0 }, // ESTR — synthetic quarter Δ stays inside the amber cut (GREEN pin)
  { name: "ECISS", base: 0.08 }, // ECISS (ECB CISS) — synthetic level + Δ20 stay inside both amber cuts (GREEN pin)
  { name: "EURGBP", base: 0.85 }, // EURGBP (ECB EUR/GBP ref rate)
  { name: "CP0000EZ19M086NEST", base: 120, cadence: "monthly" }, // HICP (FRED euro-area HICP index → hicpDelta6m)
  // Price feed (PRICE_SCORERS inputs ∪ DOWNSIDE_DETECTORS symbols)
  { name: "SMH", base: 220 },
  { name: "NVDA", base: 120 },
  { name: "QQQ", base: 450 },
  { name: "QQQE", base: 80 },
  { name: "SPY", base: 520 }, // also GB member, DISP leg, pension US leg
  { name: "RSP", base: 160 },
  { name: "MU", base: 110 },
  { name: "HYG", base: 78 },
  { name: "LQD", base: 108 },
  { name: "XLK", base: 200 }, // DB_XLK closes + pension SP500IT ticker
  { name: "KBE", base: 55 }, // KBE_RS numerator (÷ SPY)
  // GB members not otherwise present
  { name: "VGK", base: 65 },
  { name: "EWJ", base: 70 },
  { name: "VWO", base: 42 },
  { name: "XLP", base: 75 },
  { name: "XLV", base: 140 },
  { name: "VYM", base: 115 },
  // Pension legs
  { name: "VEA", base: 50 },
  // Comparator sleeves not otherwise present (SPY/SMH/VWO/VGK already are, above).
  { name: "XDEV.DE", base: 45 },
  { name: "000660.KS", base: 180000 }, // HYNIX (value-ladder display-only comparator, KRW)
  { name: "AMAT", base: 160 }, // AMAT (value-ladder display-only comparator)
  { name: "KRW=X", base: 1380 }, // KRW (value-ladder display-only comparator; HG=F is already in, above)
  { name: "BAMLC0A4CBBB", base: 1.0 }, // BBB (value-only CONTEXT card, FRED series via INPUT_SERIES)
  { name: "EXSH.DE", base: 12 }, // LEGP_EUFIN held-sleeve detail row
  { name: "QDVG.DE", base: 40 }, // LEGP_HEALTH sleeve detail row
  { name: "LYTR.DE", base: 35 }, // LEGP_COMMOD off-ladder commodities detail row
  { name: "PSWD.DE", base: 55 }, // LEGP_RAFI off-ladder AW-Fundamental detail row
  { name: "QDVE.DE", base: 30 }, // LEGP_SPIT ladder-leg detail row (SMH/VEA already present, above)
  { name: "IS3N.DE", base: 33 }, // LEGP_EM ladder-leg detail row
  { name: "SXR8.DE", base: 580 }, // LEGP_SPX ladder-leg detail row
  { name: "ZPDS.DE", base: 45 }, // LEGP_STAPLES ladder-leg detail row
  { name: "EXSA.DE", base: 63 }, // EXSH_GATE + INS_RS rel-strength denominator (EXSH.DE ÷, EXH5.DE ÷)
  { name: "EXH5.DE", base: 50 }, // INS_RS numerator (STOXX Europe 600 Insurance, ÷ EXSA.DE)
  { name: "XAT1.DE", base: 5 }, // AT1 numerator (Invesco USD AT1 CoCo ETF, EUR-hedged)
  { name: "EXHA.DE", base: 121 }, // AT1 denominator (Bund ETF, eb.rexx Govt Germany)
  // HCX basket legs (Stage 1) — the four hyperscaler capex buyers, equal-weighted into a return
  // chain ÷ SPY by scoreHcx. FDX foundry leg: TSM (SMH is already present above).
  { name: "GOOGL", base: 170 },
  { name: "META", base: 500 },
  { name: "MSFT", base: 420 },
  { name: "AMZN", base: 185 },
  { name: "TSM", base: 175 }, // FDX numerator (÷ SMH)
  { name: "1306.T", base: 420 }, // JPT (TOPIX ETF, GT shape)
  // F7 CAPE (persisted monthly series; priceLegReadingSeries projection)
  { name: "CAPE", base: 32, cadence: "monthly" },
];

/** Generated weekday (or weekly/monthly) date sequence ending at ASOF, oldest→newest. */
function dateSequence(cadence: Cadence, rows: number): string[] {
  const out: string[] = [];
  const d = new Date(`${ASOF}T00:00:00Z`);
  if (cadence === "monthly") {
    d.setUTCDate(1);
    while (out.length < rows) {
      out.push(isoDay(d));
      d.setUTCMonth(d.getUTCMonth() - 1);
    }
  } else if (cadence === "weekly") {
    while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1); // last Wednesday ≤ ASOF
    while (out.length < rows) {
      out.push(isoDay(d));
      d.setUTCDate(d.getUTCDate() - 7);
    }
  } else {
    while (out.length < rows) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) out.push(isoDay(d));
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  return out.reverse();
}

/** Tiny seeded LCG noise + per-series analytic drift around each spec's base level. */
function generateSeries(spec: SeriesSpec, seed: number): Observation[] {
  const cadence = spec.cadence ?? "daily";
  const rows = cadence === "daily" ? DAILY_ROWS : cadence === "weekly" ? WEEKLY_ROWS : MONTHLY_ROWS;
  const lead = spec.leadRows ?? 0;
  const dates = dateSequence(cadence, lead + rows);
  const rand = seriesRand(seed, spec.name);
  // i = 0 is the tail's first row; the lead prefix is i < 0, drawn AFTER the tail so the tail is unmoved.
  const at = (i: number): number => {
    const wave = Math.sin(i / 37) * 0.06 + Math.sin(i / 11) * 0.02;
    const noise = (rand() - 0.5) * 0.03;
    const drift = 0.04 * (i / rows - 0.5);
    // Round so the JSON round-trips bit-exactly and stays diff-readable.
    return Number((spec.base * (1 + wave + noise + drift)).toFixed(6));
  };
  const tail = Array.from({ length: rows }, (_, i) => at(i));
  const prefix = Array.from({ length: lead }, (_, k) => at(k - lead));
  return dates.map((date, j) => ({ date, value: j < lead ? prefix[j]! : tail[j - lead]! }));
}

function writeFixture(seed: number): void {
  // MERGE over the committed fixture, never rebuild from SERIES_SPECS alone: the Stage-1/2
  // crisis series (T10YIE / T5YIFR / OVX — `^OVX` since S6, ex-OVXCLS) live in the fixture WITHOUT a SERIES_SPECS row
  // (their values are not generateSeries output), so a from-scratch rebuild silently drops
  // them and the next regen throws "fixture is missing series" (caught 2026-07-24, Stage 3).
  // SERIES_SPECS entries still regenerate deterministically (per-series seeded LCG).
  let fixture: Record<string, Observation[]> = {};
  try {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, Observation[]>;
  } catch (err) {
    // No committed fixture yet — generate SERIES_SPECS from scratch. ANNOUNCE it (§4.10): the
    // same branch catches a CORRUPTED committed fixture, where a silent rebuild drops every
    // non-SERIES_SPECS series (see the MERGE note above) and looks like a clean regen.
    console.warn(
      `[golden-regen] could not read fixture ${path.relative(process.cwd(), FIXTURE_PATH)} ` +
        `(${err instanceof Error ? err.message : String(err)}) — rebuilding from SERIES_SPECS alone; ` +
        `any series without a SERIES_SPECS row will be DROPPED.`,
    );
  }
  for (const spec of SERIES_SPECS) fixture[spec.name] = generateSeries(spec, seed);
  mkdirSync(GOLDENS_DIR, { recursive: true });
  writeFileSync(FIXTURE_PATH, stringifySorted(fixture) + "\n");
  console.log(`[golden-regen] wrote fixture (seed ${seed}) → ${path.relative(process.cwd(), FIXTURE_PATH)}`);
}

// --- Regen (default mode): fixture → shared dispatch → snapshots -----------------------

function regen(): void {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, Observation[]>;
  const readings = computeReadings(fixture);
  const charts = computeCharts();

  mkdirSync(GOLDENS_DIR, { recursive: true });
  writeFileSync(READINGS_PATH, stringifySorted(readings) + "\n");
  writeFileSync(CHARTS_PATH, stringifySorted(charts) + "\n");
  console.log(
    `[golden-regen] wrote ${Object.keys(readings).length} reading pins + ${Object.keys(charts).length} chart pins → ${path.relative(process.cwd(), GOLDENS_DIR)}/`,
  );
}

// --- CLI ------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--write-fixture")) {
  const seedIdx = args.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number(args[seedIdx + 1]) : 1;
  if (!Number.isFinite(seed)) throw new Error(`[golden-regen] bad --seed`);
  writeFixture(seed);
} else {
  regen();
}
