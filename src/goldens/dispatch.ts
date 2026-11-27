/**
 * Shared golden-pin dispatch (Stage 0.2).
 *
 * SINGLE module computing the golden snapshots from the committed fixture — imported by
 * BOTH `scripts/golden-regen.ts` (writes the JSON) and `src/golden-pins.test.ts`
 * (strict-deep-equals live output against the committed JSON), so script and test cannot
 * diverge. Deterministic: same exported scorers the run loop wires, no fetcher, no clock, no
 * store.
 *
 * Coverage rule (enforced): ids are enumerated FROM the registry — ALL_INDICATORS plus
 * the cron-persisted COMPOSITE_COMPONENTS (CMP_*) rows — never a hardcoded id list. The
 * dispatch table THROWS if any enumerated id lacks an entry or any entry names an id not
 * enumerated. The dispatch DUPLICATES the run loop's per-id argument wiring knowledge
 * (accepted for Stage 0 — see the plan's "Known conflicts"; Stage 5a may fold it back).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ALL_INDICATORS } from "../registry.js";
import {
  INDICATORS,
  EBP,
  R6,
  CCC,
  HICP,
  ECY,
} from "../registry-fred.js";
import {
  PRICE_SCORERS,
  DOWNSIDE_DETECTORS,
  RS_LEGS,
} from "../registry-price.js";
import {
  COMPOSITE_COMPONENTS,
  componentBackfillSeries,
  R7,
  CG,
  VT,
  EURC,
  EPATH,
  BUND,
  FXH,
  GT,
  GB,
  DISP,
  ESTR,
  ECISS,
  EURGBP,
  CQS,
  BONOS,
} from "../registry-composite.js";
import {
  G1,
  BRENT,
  NG,
} from "../registry-geo.js";
import {
  scoreReturnOrMaSpread,
  scoreGlobalTrend,
  downsideBreakReadingSeries,
  relStrengthBreakReadingSeries,
} from "../scorers-price.js";
import {
  scoreBonosSpread,
  scoreEcy,
  scoreBullSteepener,
  scoreRatioSpread,
  scoreCurve,
  scoreFxHaven,
  scoreGlobalBreadth,
  scoreCreditBridge,
  scoreDispersion,
} from "../scorers-composite.js";
import { GB_SYMBOLS, HCX_SYMBOLS } from "../family-descriptor-rows.js";
import { SYNTH_PRIOR_IDS, resolveCuts } from "../domain-cuts.js";
import {
  scoreOil,
  scoreDerived,
  scoreIndicator,
} from "../scorers-core.js";
import { type Observation, type Reading } from "../domain-types.js";
import { BUND_DESCRIPTOR, CG_DESCRIPTOR, EPATH_DESCRIPTOR, EURC_DESCRIPTOR } from "../family-descriptor-rows.js";
import { VIX_SYMBOL, VIX3M_SYMBOL } from "../vix_term.js";
import { HICP_SERIES, hicpDelta6m } from "../hicp.js";
import { scoreWithCuts, scoreVixTermIndicator } from "../confirmers.js";
import { type SynthHistories } from "../synth-cuts.js";
import { scoreSlow, slowStoredReadings } from "../slow.js";
import { priceLegReadingSeries } from "../pension.js";
import { buildIndicatorChart } from "../../api/indicators.js";
// Calibration vintage — the SAME committed emission the harness publishes to the store
// (deterministic per commit; a vintage change legitimately moves goldens → rebaseline).
import CALIB_JSON from "../../scripts/backtest/calibration.json" with { type: "json" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDENS_DIR = HERE;
export const FIXTURE_PATH = path.join(GOLDENS_DIR, "fixture-observations.json");
export const READINGS_PATH = path.join(GOLDENS_DIR, "golden-readings.json");
export const CHARTS_PATH = path.join(GOLDENS_DIR, "golden-charts.json");

/** Pinned as-of date every generated fixture series ends at (a weekday). */
export const ASOF = "2026-06-30";

// --- Sorted-key serialization (JSON key order must not depend on insertion order) -----

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, sortValue(rec[k])]),
    );
  }
  return v;
}

export function stringifySorted(v: unknown): string {
  return JSON.stringify(sortValue(v), null, 2);
}

/** Serialize a Reading with `indicator` collapsed to its id (the full config object
 *  would bloat and duplicate the registry). `leg`/`rawLeg` ride along via the spread. */
function collapse(r: Reading): Record<string, unknown> {
  return { ...r, indicator: r.indicator.id };
}

// --- Registry-enumerated id sets (never hardcoded) ------------------------------------

/** Readings snapshot key set: ALL_INDICATORS ∪ the cron-persisted CMP_* component ids. */
export function enumeratedReadingIds(): string[] {
  const enumerated = [
    ...ALL_INDICATORS.map((i) => i.id),
    ...Object.values(COMPOSITE_COMPONENTS).flat().map((c) => c.id),
  ];
  const set = new Set(enumerated);
  if (set.size !== enumerated.length) {
    throw new Error(`[goldens] duplicate id in the enumerated registry set`);
  }
  return [...set].sort();
}

/** Charts snapshot key set: every ALL_INDICATORS id (buildIndicatorChart accepts all). */
export function enumeratedChartIds(): string[] {
  return ALL_INDICATORS.map((i) => i.id).sort();
}

// --- Dispatch: fixture → readings / charts --------------------------------------------

/**
 * Score the fixture through the SAME per-id wiring the run loop (`run-dbfirst.ts`/`run-cycle-feeds.ts`) uses and return the readings
 * snapshot (id → serialized reading rows). Throws on any registry↔dispatch mismatch.
 */
export function computeReadings(fixture: Record<string, Observation[]>): Record<string, unknown> {
  const series = (name: string): Observation[] => {
    const s = fixture[name];
    if (!s || s.length === 0) throw new Error(`[goldens] fixture is missing series "${name}"`);
    return s;
  };

  // Calibration vintage rows, shaped as the CalibParamRow slice resolveCuts reads.
  const rawParams = (CALIB_JSON as { params: Array<Record<string, unknown>> }).params;
  const calib = rawParams.map((p) => ({
    market: (p["market"] as string | null | undefined) ?? null,
    mode: (p["mode"] as string | null | undefined) ?? null,
    channel: p["channel"] as string,
    metric: p["metric"] as string,
    value: p["value"] as number,
    ciLow: (p["ci_low"] as number | null | undefined) ?? null,
    ciHigh: (p["ci_high"] as number | null | undefined) ?? null,
    method: (p["method"] as string | undefined) ?? "unknown",
    nEvents: (p["n_events"] as number | null | undefined) ?? null,
    windowStart: (p["window_start"] as string | null | undefined) ?? null,
    windowEnd: (p["window_end"] as string | null | undefined) ?? null,
    notes: (p["notes"] as string | null | undefined) ?? null,
    computedAt: (CALIB_JSON as { computed_at: string }).computed_at,
  }));

  // Synth-prior histories from the FIXTURE (the stored level history loadSynthHistories
  // reads in prod is each synth id's own scored series = its raw series values).
  const seriesOf = new Map(ALL_INDICATORS.map((i) => [i.id, i.series]));
  /** Registry-sourced feed id for an enumerated indicator — NEVER a hand-typed literal
   *  here: a registry repoint must drag the golden's input with it. (IS-6a repointed the
   *  VIX legs onto FRED but left three `"^VIX"`/`"^VIX3M"` literals in this file, and the
   *  fixture still carried those keys, so the goldens pinned a wiring production could no
   *  longer produce — see the VT / bottom-leg asserts below.) */
  const regSeries = (id: string): string => {
    const s = seriesOf.get(id);
    if (!s) throw new Error(`[goldens] id "${id}" not in ALL_INDICATORS`);
    return s;
  };
  const synthHistories: SynthHistories = new Map(
    [...SYNTH_PRIOR_IDS].map((id) => [id, series(regSeries(id)).map((o) => o.value)] as const),
  );

  // Dispatch table: id → rows, mirroring the run loop's per-id argument wiring (never a fetcher).
  const table = new Map<string, () => Array<Record<string, unknown>>>();
  const add = (id: string, fn: () => Array<Record<string, unknown>>): void => {
    if (table.has(id)) throw new Error(`[goldens] duplicate dispatch entry for "${id}"`);
    table.set(id, fn);
  };

  // 1) FRED core loop — scoreWithCuts (resolveCuts + synthesizedCalib inside).
  for (const ind of INDICATORS) {
    add(ind.id, () => {
      const obs = series(ind.series);
      return [collapse(scoreWithCuts(ind, obs, calib, undefined, synthHistories))];
    });
  }

  // 2) Price batch — the PRICE_SCORERS table's own series() bodies over the deduped symbol union; a non-`backfill`
  // row's live commit reading only.
  const priceSymbols = [
    ...new Set([
      ...PRICE_SCORERS.flatMap((s) => s.inputs),
      ...DOWNSIDE_DETECTORS.map((d) => d.symbol),
      ...RS_LEGS.flatMap((l) => l.symbols),
    ]),
  ];
  const bySymbol: Record<string, Observation[]> = {};
  for (const sym of priceSymbols) bySymbol[sym] = series(sym);
  for (const spec of PRICE_SCORERS) {
    add(spec.indicator.id, () => (spec.backfill ? spec.series(bySymbol) : spec.series(bySymbol).slice(-1)).map(collapse));
  }
  // Downside-break detectors (full guard-light series; run-dbfirst.ts persists `.at(-1)`).
  for (const d of DOWNSIDE_DETECTORS) {
    add(d.indicator.id, () => downsideBreakReadingSeries(d.indicator, bySymbol[d.symbol] ?? []).map(collapse));
  }
  // EW rel-strength legs (same guard-light series shape; run-cycle persists `.at(-1)`).
  for (const l of RS_LEGS) {
    add(l.indicator.id, () =>
      relStrengthBreakReadingSeries(l.indicator, bySymbol[l.symbols[0]] ?? [], bySymbol[l.symbols[1]] ?? []).map(collapse),
    );
  }

  // 3) Fast confirmers (FAST_CONFIRMERS wiring, minus the fetchers).
  add(G1.id, () => [collapse(scoreOil(G1, series(G1.series)))]);
  add(BRENT.id, () => [collapse(scoreOil(BRENT, series(BRENT.series)))]); // same merged scorer as G1 since 2026-08-06
  add(NG.id, () => [collapse(scoreOil(NG, series(NG.series)))]); // same merged scorer as G1/BRENT
  add(EBP.id, () => [collapse(scoreWithCuts(EBP, series("ebp"), calib))]);
  add(R6.id, () => [collapse(scoreWithCuts(R6, series("^MOVE"), calib))]);
  add(R7.id, () => [collapse(scoreBullSteepener(R7, series("T10Y3M"), series("DGS2"), series("DGS10")))]);
  add(CG.id, () => [collapse(scoreRatioSpread(CG, CG_DESCRIPTOR, series("HG=F"), series("GC=F")))]);
  // VT reads the SHARED two-leg vix_term feed (VIXCLS front ÷ VXVCLS back), and its own
  // registry `series` IS that numerator — assert the two agree so repointing one without
  // the other reds here instead of quietly feeding the goldens a second VIX series.
  if (VT.series !== VIX_SYMBOL) {
    throw new Error(`[goldens] VT.series "${VT.series}" ≠ vix_term VIX_SYMBOL "${VIX_SYMBOL}"`);
  }
  add(VT.id, () => scoreVixTermIndicator(series(VT.series), series(VIX3M_SYMBOL)).map(collapse));

  // 4) GLOBAL_FEEDS (run-cycle-feeds.ts wiring; CMP_* component rows split out below).
  add(EURC.id, () => [collapse(scoreRatioSpread(EURC, EURC_DESCRIPTOR, series("SR_10Y"), series("SR_3M")))]);
  add(EPATH.id, () => [collapse(scoreRatioSpread(EPATH, EPATH_DESCRIPTOR, series("SR_1Y"), series("ESTR")))]);
  add(BUND.id, () => [collapse(scoreCurve(BUND, BUND_DESCRIPTOR, series("DE10Y"), series("DE2Y")))]);
  add(FXH.id, () => [collapse(scoreFxHaven(FXH, series("EURUSD=X"), series("CHF=X"), series("JPY=X")))]);
  add(GT.id, () => [collapse(scoreGlobalTrend(GT, series("ACWI")))]);
  // ECY — GT-gated valuation. Fixture CAPE (MONTHLY_ROWS 90) < PCT_MIN_OBS pins the floor
  // semantics as zero rows; scorer values are pinned by dashboard.composites.test.ts instead.
  add(ECY.id, () => {
    const r = scoreEcy(ECY, series("CAPE"), series("DFII10"), scoreGlobalTrend(GT, series("ACWI")).state, ASOF);
    return r ? [collapse(r)] : [];
  });
  add(GB.id, () => {
    const gbBySymbol: Record<string, Observation[]> = {};
    for (const s of [...new Set(GB_SYMBOLS)]) gbBySymbol[s] = series(s);
    return [collapse(scoreGlobalBreadth(GB, gbBySymbol))];
  });
  add(DISP.id, () => [collapse(scoreDispersion(DISP, series("SPY"), series("FEZ"), series("EEM")))]);
  add(ESTR.id, () => [collapse(scoreDerived(ESTR, series("ESTR")))]);
  add(ECISS.id, () => [
    collapse(scoreIndicator(ECISS, series("ECISS"), resolveCuts(ECISS.id, calib, ECISS.direction ?? "HIGH"))),
  ]);
  add(EURGBP.id, () => [collapse(scoreReturnOrMaSpread(EURGBP, series("EURGBP")))]);
  add(HICP.id, () => [
    collapse(scoreIndicator(HICP, hicpDelta6m(series(HICP_SERIES)), resolveCuts(HICP.id, calib, HICP.direction ?? "HIGH"))),
  ]);
  add(CCC.id, () => [
    collapse(scoreIndicator(CCC, series(CCC.series), resolveCuts(CCC.id, calib, CCC.direction ?? "HIGH"))),
  ]);
  // CQS — the Baa−Aaa EBP-bridge (2026-08-16). Three inputs: the two FRED legs inner-joined by the
  // scorer plus `series("ebp")` (the fetchEbp monthly fixture) for the R2 month-END anchor.
  add(CQS.id, () => [collapse(scoreCreditBridge(CQS, series("BAA10Y"), series("AAA10Y"), series("ebp")))]);

  // BONOS — the country leg minus the "DE10Y" fixture series (at run time the sovereign-quote `de10yP`, BUND's leg).
  add(BONOS.id, () => [collapse(scoreBonosSpread(BONOS, series("ES10Y"), series("DE10Y")))]);

  // 5) CMP_* composite-component vintage rows (registry COMPOSITE_COMPONENTS, cron-persisted).
  const cmpInputs: Record<string, Record<string, Observation[]>> = {
    EURC: { SR_10Y: series("SR_10Y"), SR_3M: series("SR_3M") },
    BUND: { DE10Y: series("DE10Y"), DE2Y: series("DE2Y") },
    BONOS: { ES10Y: series("ES10Y") },
    FXH: { "EURUSD=X": series("EURUSD=X"), "CHF=X": series("CHF=X"), "JPY=X": series("JPY=X") },
    GT: { ACWI: series("ACWI") },
    GB: Object.fromEntries([...new Set(GB_SYMBOLS)].map((s) => [s, series(s)])),
    DISP: { SPY: series("SPY"), FEZ: series("FEZ"), EEM: series("EEM") },
    HCX: Object.fromEntries([...new Set(HCX_SYMBOLS)].map((s) => [s, series(s)])),
    FDX: { TSM: series("TSM"), SMH: series("SMH") },
  };
  for (const [composite, components] of Object.entries(COMPOSITE_COMPONENTS)) {
    const inputs = cmpInputs[composite];
    if (!inputs) throw new Error(`[goldens] no fixture inputs for composite "${composite}"`);
    for (const c of components) {
      add(c.id, () =>
        componentBackfillSeries(composite, inputs)
          .filter((b) => b.id === c.id)
          .map((b) => collapse(b.series.at(-1)!)),
      );
    }
  }

  // 6) F7 CAPE + slow / pension / bottom track legs (StoredReading projections — these
  //    rows already carry `indicatorId`, no collapse needed).
  add("F7", () => priceLegReadingSeries("F7", series("CAPE")) as unknown as Array<Record<string, unknown>>);
  const slowRows = (): Array<Record<string, unknown>> => {
    const scored = scoreSlow(series("QQQ"), series("VIXCLS"));
    return slowStoredReadings(scored.observability, ASOF) as unknown as Array<Record<string, unknown>>;
  };
  for (const id of ["price-accel", "complacency-vix", "complacency-high", "complacency-duration"]) {
    add(id, () => slowRows().filter((r) => r["indicatorId"] === id));
  }
  const pensionSeries: Record<string, string> = {
    SPY: "SPY",
    DEXUSEU: "DEXUSEU",
    SP500IT: "XLK", // store-id ≠ fetch-ticker split (registry PENSION_INDICATORS)
    // Held EU-Fin sleeve — live rows are `legCloseReadingRows` chained levels (scoreboard), but the
    // golden only pins the registry row's projection shape, so the same raw-close projection serves.
    LEGP_EUFIN: "EXSH.DE",
    LEGP_HEALTH: "QDVG.DE",
    // Off-ladder commodities detail row — same registry-projection shape; live rows are the
    // scoreboard chained level. Store id ≠ ticker (`LYTR.DE`).
    LEGP_COMMOD: "LYTR.DE",
    // Off-ladder AW-Fundamental detail row — same registry-projection shape; store id ≠ ticker (`PSWD.DE`).
    LEGP_RAFI: "PSWD.DE",
    // The remaining ladder legs — same registry-projection shape (the SMH/VEA fixtures F4/F6/FDX also read).
    LEGP_SEMIS: "SMH",
    LEGP_SPIT: "QDVE.DE",
    LEGP_EM: "IS3N.DE",
    LEGP_SPX: "SXR8.DE",
    LEGP_EXUS: "VEA",
    LEGP_STAPLES: "ZPDS.DE",
    // Comparator legs — unweighted PENSION sleeves; same raw-close projection, store id = ticker.
    VWO: "VWO",
    VGK: "VGK",
    // EUR-native comparator (Xetra) — store id `XDEV`, ticker `XDEV.DE`, another
    // store-id ≠ fetch-ticker split. NOT `LEGP_VALUE`, the chained level on the same ticker.
    XDEV: "XDEV.DE",
    // Value-ladder input: KBE store id = ticker.
    KBE: "KBE",
    // Display-only comparator reads of the value probe: HYNIX store id ≠ its KRX ticker; AMAT = ticker.
    HYNIX: "000660.KS",
    AMAT: "AMAT",
    // Display-only change lines of the value probe: store id ≠ the closes-feed FX / futures ticker.
    KRW: "KRW=X",
    COPPER: "HG=F",
    // BBB OAS (value-only CONTEXT, INPUT_SERIES raw rows): store id ≠ its FRED series.
    BBB: "BAMLC0A4CBBB",
  };
  for (const [id, sym] of Object.entries(pensionSeries)) {
    add(id, () => priceLegReadingSeries(id, series(sym)) as unknown as Array<Record<string, unknown>>);
  }
  // Bottom track: tracks.ts persists the SHARED vix_term legs under these two ids, so each
  // leg's registry `series` must be exactly the vix_term symbol it is fed from.
  for (const [id, symbol] of [
    ["VIX", VIX_SYMBOL],
    ["VIX3M", VIX3M_SYMBOL],
  ] as const) {
    const s = regSeries(id);
    if (s !== symbol) throw new Error(`[goldens] bottom leg "${id}" series "${s}" ≠ vix_term "${symbol}"`);
    add(id, () => priceLegReadingSeries(id, series(s)) as unknown as Array<Record<string, unknown>>);
  }

  // Completeness assert (enforced, not aspirational): the enumerated registry id set —
  // ALL_INDICATORS ∪ the cron-persisted CMP_* component ids — must equal the dispatch keys.
  const enumeratedSet = new Set(enumeratedReadingIds());
  for (const id of enumeratedSet) {
    if (!table.has(id)) throw new Error(`[goldens] registry id "${id}" has no dispatch entry — extend the goldens`);
  }
  for (const id of table.keys()) {
    if (!enumeratedSet.has(id)) throw new Error(`[goldens] stale dispatch entry "${id}" — not in the registry`);
  }

  const readings: Record<string, unknown> = {};
  for (const [id, fn] of table) readings[id] = fn();
  return readings;
}

/**
 * Frozen chart spec per ALL_INDICATORS id (the /api/indicators GET surface;
 * buildIndicatorChart includes the fromDays window policy — the sanctioned pin seam).
 */
export function computeCharts(): Record<string, unknown> {
  const charts: Record<string, unknown> = {};
  for (const ind of ALL_INDICATORS) charts[ind.id] = buildIndicatorChart(ind);
  return charts;
}
