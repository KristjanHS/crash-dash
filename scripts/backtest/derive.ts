/**
 * Backtest DERIVE step (Stage 1, run via `npx tsx scripts/backtest/derive.ts`).
 *
 * PURE transform: reads the committed raw fixtures under `data/` and writes derived
 * fires-mask CSVs from the REAL live scorers (`src/scorers-*.ts`), so the harness carries
 * ZERO mirrored scoring logic — the TS scorers are the single source of truth for every
 * indicator's decision variable. No network (that stays the offline fetcher's charter): a pure
 * transform lets the derived fixtures be regenerated offline from the committed raw ones,
 * preserving the harness's byte-deterministic-offline property and making each derived CSV
 * a reviewable pure diff of its raw inputs.
 *
 * Stage 1 emits the two COMPOUND fires-masks (F4 semis, F5 breadth) — the ones the old
 * plan would have re-ported into Python. `fires = 1` iff the scorer's RAW (pre-confirmation)
 * state is elevated (≠ GREEN): the harness lift path measures off raw level-crossings for
 * every prefix, never confirmed states (`Reading.rawState` carries exactly this). Both masks are
 * `rawState !== GREEN`, so each admits AMBER-or-RED — F5's dynamic percentile band can RED since
 * that band landed. The harness forward-fills the mask onto the NDX grid → per-mode lift.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { Observation, Reading } from "../../src/domain-types.js";
import { F4, F5 } from "../../src/registry-price.js";
import { G1 } from "../../src/registry-geo.js";
import { semisReadingSeries, breadthReadingSeries } from "../../src/scorers-price.js";
import { trailingReturn } from "../../src/scorers-core.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

/**
 * Parse a `date,value` fixture CSV (oldest→newest) into Observations. Skips the header
 * and any non-finite row — mirrors the harness `_load_csv` finite guard so the two agree
 * on which rows exist. No sort: fixtures are written oldest→newest by the offline fetcher and the
 * scorers' date-alignment does not depend on a re-sort.
 */
export function readCsv(name: string): Observation[] {
  const body = readFileSync(join(DATA_DIR, `${name}.csv`), "utf8").trim();
  const out: Observation[] = [];
  for (const line of body.split("\n").slice(1)) {
    const [date, value] = line.split(",");
    const v = Number(value);
    if (!date || !Number.isFinite(v)) continue;
    out.push({ date, value: v });
  }
  return out;
}

/** `1` iff the raw (pre-confirmation) state is elevated (≠ GREEN) — the fires bit. */
export function firesBit(r: Reading): 0 | 1 {
  return r.rawState === "GREEN" ? 0 : 1;
}

/** Emit `date,fires` (`fires ∈ {0,1}`) from a scorer's raw-state series. */
export function toFiresCsv(readings: Reading[]): string {
  return "date,fires\n" + readings.map((r) => `${r.date},${firesBit(r)}`).join("\n") + "\n";
}

/**
 * Trailing %-return DECISION VARIABLE rows for a raw level fixture, in the SHAPE the
 * harness consumes (Stage 2, wti-only slice).
 *
 * The transform is the live one — `trailingReturn` (the same `trailingReturnAt` the live
 * `derivedValue("return")` calls), so the TS scorer stays the single source of truth for
 * G1's decision variable. Only the SHAPE differs, deliberately: `trailingReturn` emits
 * `null` IN PLACE on a bad base (length preserved, so `derivedRawStateSeries` keeps its
 * index alignment), while the harness's `_return_rows` DROPS those rows (each row carries
 * its own date, so nothing downstream is lost). This emitter applies that drop, which is
 * what makes the emitted CSV byte-identical to the vintage the harness computed itself.
 *
 * Sorts by date first to mirror `_load_csv`'s `rows.sort()` — the fixtures are already
 * oldest→newest, so this is a parity guard, not a fix.
 */
export function toReturnRows(obs: Observation[], window: number): Observation[] {
  const rows = [...obs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const values = rows.map((o) => o.value);
  const out: Observation[] = [];
  trailingReturn(values, window).forEach((v, k) => {
    if (v !== null) out.push({ date: rows[window + k]!.date, value: v });
  });
  return out;
}

/**
 * Emit `date,value` at FULL precision: `String(v)` is JS's shortest round-tripping
 * decimal form, which Python's `float()` parses back to the identical double — so the
 * JS→CSV→Python hop is lossless and the harness sees the exact IEEE-754 result.
 */
export function toValueCsv(rows: Observation[]): string {
  return "date,value\n" + rows.map((r) => `${r.date},${String(r.value)}`).join("\n") + "\n";
}

function write(name: string, csv: string): void {
  const rows = csv.trimEnd() === "" ? 0 : csv.trimEnd().split("\n").length - 1;
  writeFileSync(join(DATA_DIR, `${name}.csv`), csv);
  console.log(`[write] ${name}.csv (${rows} rows)`);
}

function main(): void {
  mkdirSync(DATA_DIR, { recursive: true });

  // F4 semis compound: SMH + NVDA ADJUSTED closes (match the live prices.ts → scoreSemis
  // feed — the single-source point). fires = AMBER|RED.
  const f4 = semisReadingSeries(F4, readCsv("smh_adj"), readCsv("nvda_adj"));
  write("f4c_fires", toFiresCsv(f4));

  // F5 breadth compound: QQQ / QQQE RAW ratio (common split/div adjustment cancels in the
  // ratio; neither leg has an in-window split). fires = AMBER|RED (the dynamic band can RED).
  const breadth = breadthReadingSeries(F5, readCsv("qqq"), readCsv("qqqe"));
  write("breadth_fires", toFiresCsv(breadth));

  // G1 oil %-return decision variable (Stage 2, wti-only slice): the harness used to
  // re-derive this in Python (`_return_rows`); it now reads this CSV. Window comes off
  // the LIVE G1 `derived` descriptor, so the lookback can't drift from the scorer either.
  const g1 = G1.derived!;
  write("wti_ret", toValueCsv(toReturnRows(readCsv("wti"), g1.window!)));

  console.log("done.");
}

// Run only when invoked directly (`npx tsx scripts/backtest/derive.ts`), NOT when imported
// by the unit test — importing must be side-effect-free. vitest sets argv[1] to its own
// runner, so isMain is false there.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
