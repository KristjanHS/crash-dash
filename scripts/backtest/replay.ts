/**
 * Fire-list replay (run via `npx tsx scripts/backtest/replay.ts`): feeds the committed
 * fixtures through the REAL production scorers (`rawStateSeries` / `derivedRawStateSeries` /
 * `deriveConfirmedState`) — never a reimplementation; the streaming fold self-checks
 * against `deriveConfirmedState` on every run. The legacy verdict-track spine
 * (legacyVerdict / kiley / alert_track.json / d2_fires.json / counterfactual.json /
 * p1_fin_crit.json) was deleted 2026-08-15 with legacy-ladder.ts + kiley.ts; the committed
 * data/ copies of those artifacts are frozen vintages.
 *
 * Output: data/indicator_fires.json — per-indicator episodes labelled per (market, mode)
 * with windowed forward drawdown + NDX-cell mode buckets; data/warning_fires.json,
 * data/phase2_warning_fires.json, data/phase2_sweeps.json; data/bottom_sweep.json,
 * data/copper_gold_sweep.json, data/slow_calm_sweep.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  INDICATORS,
  EBP,
  R6,
} from "../../src/registry-fred.js";
import { G1 } from "../../src/registry-geo.js";
import { VT } from "../../src/registry-composite.js";
import {
  CONFIRM_CLOSES,
  VELOCITY_WINDOW,
  STATE_RANK,
  type Indicator,
  type Observation,
  type State,
} from "../../src/domain-types.js";
import {
  rawStateSeries,
  deriveConfirmedState,
  confirmedSeries as foldConfirmed,
} from "../../src/domain-fold.js";
import { derivedRawStateSeries, alignByDate } from "../../src/scorers-core.js";
import { ratioSpreadReadingSeries } from "../../src/scorers-composite.js";
import {
  CG_AMBER_RET,
  CG_RED_RET,
  VT_AMBER_RATIO,
  VT_RED_RATIO,
} from "../../src/family-descriptor-rows.js";
import { CG_DESCRIPTOR, VT_DESCRIPTOR } from "../../src/family-descriptor-rows.js";
import { alignTermStructure } from "../../src/vix_term.js";
import { BOTTOM_DEFAULTS, bottomRawStateSeries, type BottomParams } from "../../src/bottom.js";
import { durationOfCalmRawStateSeries, VIX_LOW_PCTILE } from "../../src/slow.js";
import { expandingZ } from "./expanding-z.js";

// --- Credit base (Option 3: point-in-time Baa−10Y proxy-z) ----------------------
//
// The replay's FIN BASE. Mirrors the live F1/F2 proxy-z leg (scorers.ts proxyZSeries)
// but computes a POINT-IN-TIME expanding-z (each day uses only prior data) instead of
// the harness's full-sample zref — so it is look-ahead-clean (Decision 1/3). The z-cuts
// are the CONVENTION Z_CUTS (1.5σ amber / 2.0σ red, the retired harness.py's Z_CUTS) — a
// pre-registered design constant, never a harness-measured cut. HIGH polarity: a credit
// WIDENING (higher Baa−10Y) is the stress, so the raw z is the stress score directly.
export const CREDIT_Z_AMBER = 1.5;
export const CREDIT_Z_RED = 2.0;
// Expanding-z warmup before the sd is trustworthy — matches harness WARMUP.daily (252).
export const CREDIT_WARMUP = 252;

// Replay-local FIN base id (AUDIT-2 RESOLVED): a DEDICATED `credit-proxy` indicator,
// NOT a reuse of F1/F2 — clean track provenance, no F1/F2 collision risk if the
// native OAS legs are ever wired in. Kept replay-local, off the live alert path.
const CREDIT_PROXY: Indicator = {
  id: "credit-proxy",
  label: "Credit proxy (Baa−10Y point-in-time z)",
  longLabel: "Credit proxy (Baa−10Y point-in-time z)",
  series: "baa10y",
  channel: "FIN",
  thresholds: {}, // bespoke z-only scorer (creditProxyRawStates), not classify()
  direction: "HIGH",
  confirmer: false,
};

// Replay-local copper/gold indicator stub (T2.2 warning-validation, mirrors the G1/CREDIT_PROXY
// stubs). `ratioSpreadReadingSeries` reads only `.indicator` for the Reading label — the band logic
// is `ratioSpreadState` over CG_DESCRIPTOR, so these indicator fields never touch scoring. Kept replay-local (no
// registry wiring) exactly like CREDIT_PROXY: the harness measures the raw channel, prod is untouched.
export const CG_IND: Indicator = {
  id: "copper-gold",
  label: "Copper/gold ratio 20d return",
  longLabel: "Copper/gold ratio 20d return",
  series: "copper-gold",
  channel: "GEO",
  thresholds: {}, // bespoke return-band scorer (ratioSpreadState, CG_DESCRIPTOR), not classify()
  direction: "LOW", // a FALLING ratio (negative 20d return) is the risk-off signal
  confirmer: false,
};

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

function loadCsv(name: string): Observation[] {
  const lines = readFileSync(join(DATA_DIR, `${name}.csv`), "utf8").trim().split("\n");
  const out: Observation[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i]!.split(",");
    const value = Number(raw);
    if (!date || !Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

/**
 * Streaming version of `deriveConfirmedState`: the confirmed state AFTER each raw
 * close (same forward scan, emitting at every step instead of only the last). Its
 * final element MUST equal `deriveConfirmedState(rawStates, closes)` — asserted
 * below as a per-indicator fidelity guard against this fold drifting from the
 * production one.
 */
function confirmedSeries(rawStates: State[], closes: number): State[] {
  if (rawStates.length === 0) return [];
  let confirmed = rawStates[0]!;
  const out: State[] = [];
  for (let i = 0; i < rawStates.length; i++) {
    if (i >= closes - 1) {
      const candidate = rawStates[i]!;
      if (candidate !== confirmed) {
        let held = true;
        for (let j = i - closes + 1; j <= i; j++) {
          if (rawStates[j] !== candidate) {
            held = false;
            break;
          }
        }
        if (held) confirmed = candidate;
      }
    }
    out.push(confirmed);
  }
  return out;
}

/** An indicator paired with its fixture and raw-state rule. */
interface Channel {
  indicator: Indicator;
  fixture: string;
  oil: boolean;
  /** credit-proxy z-only base (Baa−10Y PIT-z vs Z_CUTS), not classify()/oil. */
  creditZ?: boolean;
}

/**
 * Raw (unconfirmed) states for the credit-proxy FIN base, aligned to
 * `obs[VELOCITY_WINDOW..]` exactly like `rawStateSeries`/`derivedRawStateSeries` so it
 * drops into the same spine machinery. The z is computed POINT-IN-TIME over the full
 * value series (expandingZ uses only pre-t data), then gated: GREEN until the absolute
 * index clears CREDIT_WARMUP (sd untrustworthy before then — mirrors harness), else
 * RED ≥ 2.0σ / AMBER ≥ 1.5σ / GREEN. No look-ahead: expandingZ never reads a future
 * obs and the cuts are convention constants, not harness-measured.
 */
export function creditProxyRawStates(obs: Observation[]): State[] {
  const z = expandingZ(obs.map((o) => o.value));
  const out: State[] = [];
  for (let i = VELOCITY_WINDOW; i < obs.length; i++) {
    let st: State = "GREEN";
    const zi = z[i]!;
    if (i >= CREDIT_WARMUP && Number.isFinite(zi)) {
      if (zi >= CREDIT_Z_RED) st = "RED";
      else if (zi >= CREDIT_Z_AMBER) st = "AMBER";
    }
    out.push(st);
  }
  return out;
}

const ind = (id: string): Indicator => {
  const found = INDICATORS.find((i) => i.id === id);
  if (!found) throw new Error(`indicator ${id} not found`);
  return found;
};

/**
 * Worst forward decline in a label series from the entry close over `win` trading days:
 * `min(close over [entry, entry+win]) / entryClose − 1` (≤ 0). Returns null when the entry
 * predates the series' first close (anchoring a 1962 fire on the 1985 NDX start would fabricate
 * one shared label for two decades of fires), when no close lands on-or-after the entry date, or
 * when the forward window runs past the fixture end (a still-open window must not read as a
 * shallow drawdown). Within the span, an entry in a calendar gap anchors on the next close.
 */
export function maxForwardDrawdown(series: Observation[], entryDate: string, win: number): number | null {
  if (series.length === 0 || series[0]!.date > entryDate) return null;
  const i0 = series.findIndex((o) => o.date >= entryDate);
  if (i0 < 0) return null;
  const end = i0 + win;
  if (end >= series.length) return null;
  const entryClose = series[i0]!.value;
  let min = entryClose;
  for (let i = i0; i <= end; i++) if (series[i]!.value < min) min = series[i]!.value;
  return min / entryClose - 1;
}

// --- Modes & markets (slice 1 — modes-and-markets design ①, 2026-07-02) -----------
//
// A cell = (market, mode). The replay's VERDICT target stays NDX this slice; SPX/EAFE are raw
// forward-drawdown label columns only (pension-depth fixtures: spy 1993+, vea 2007+ — precedent-
// partial, no cell verdicts yet). A mode is a severity target (fwd drawdown ≤ θ within a window);
// its bucket edges grade each fire's label. Contract (design doc Decision 4): crash keeps the
// audit's original by-eye split EXACTLY (caught ≤−15% / minor −15..−8% / noise >−8%, now over the
// crash 63td window); bear/correction scale BOTH edges by θ ratio.
export const MARKET_FIXTURES = { NDX: "ndx", SPX: "spy", EAFE: "vea" } as const;
export type Market = keyof typeof MARKET_FIXTURES;
const MARKET_NAMES = Object.keys(MARKET_FIXTURES) as Market[];

export interface Mode {
  /** Severity target: fwd drawdown ≤ θ within the window. */
  theta: number;
  /** Forward window in trading days (3/6/12 months ≈ 63/126/252 td). */
  windowTd: number;
  /** Bucket edge: dd ≤ caughtBar → "caught". */
  caughtBar: number;
  /** Bucket edge: dd ≤ noiseBar → "minor"; above it → "noise". */
  noiseBar: number;
}
const CRASH_THETA = -0.3;
const CRASH_CAUGHT_BAR = -0.15;
const CRASH_NOISE_BAR = -0.08;
const mode = (theta: number, windowTd: number): Mode => {
  const k = theta / CRASH_THETA;
  return { theta, windowTd, caughtBar: CRASH_CAUGHT_BAR * k, noiseBar: CRASH_NOISE_BAR * k };
};
export const MODES = {
  correction: mode(-0.1, 126), // ≤−10% within 6mo; buckets −5% / −2.67%
  bear: mode(-0.2, 252), // ≤−20% within 12mo; buckets −10% / −5.33%
  crash: mode(CRASH_THETA, 63), // ≤−30% within 3mo; buckets −15% / −8% (the original split)
} as const;
export type ModeName = keyof typeof MODES;
const MODE_NAMES = Object.keys(MODES) as ModeName[];

export type Bucket = "caught" | "minor" | "noise";

/** Mode-bucket of a windowed forward drawdown; null passes through (still-open window). */
export function bucketDrawdown(dd: number | null, m: Mode): Bucket | null {
  if (dd === null) return null;
  if (dd <= m.caughtBar) return "caught";
  if (dd <= m.noiseBar) return "minor";
  return "noise";
}

const CHANNELS: Channel[] = [
  { indicator: ind("R1"), fixture: "t10y3m", oil: false },
  { indicator: ind("R2"), fixture: "dgs10", oil: false },
  { indicator: ind("R3"), fixture: "dgs2", oil: false },
  { indicator: ind("R4"), fixture: "dfii10", oil: false },
  { indicator: ind("R5"), fixture: "vix", oil: false },
  // R6 MOVE (bond-market vol) — live COINCIDENT confirmer (`scoreMoveIndicator`), level-only HIGH
  // bands read from the registry pair (retuned twice by [USER] ruling: 120/150 → 90/105 → the
  // shipped pair). Single fixture, so a plain row:
  // confirmedByDate's default branch is
  // rawStateSeries(R6, move) — byte-identical to moveConfirmedByDate() and to the live scorer.
  // R6 is NOT in INDICATORS, so the direct symbol (ind("R6") would throw), like G1/CREDIT_PROXY/EBP.
  { indicator: R6, fixture: "move", oil: false },
  { indicator: G1, fixture: "wti", oil: true },
  // FIN credit (Option 3): Baa−10Y PIT-z BASE + EBP CONFIRMER, deep substitutes for the
  // native OAS legs (~3yr keyless wall).
  { indicator: CREDIT_PROXY, fixture: "baa10y", oil: false, creditZ: true },
  { indicator: EBP, fixture: "ebp", oil: false },
];

/** Per-indicator date→confirmed-state, plus the date→level for synthesized Readings. */
function confirmedByDate(ch: Channel): { dates: string[]; state: Map<string, State>; level: Map<string, number> } {
  const obs = loadCsv(ch.fixture);
  // Absolute-only baseline (no calib passed): replay folds the convention thresholds,
  // NOT the measured legs the LIVE scorer now consumes via getCalibration() (threshold-
  // provenance Phase 3). The calibration is what THIS harness PRODUCES from full history;
  // feeding it back into the replay would be look-ahead/in-sample. The harness's own
  // expanding-z validation covers the point-in-time measured legs separately.
  const raw = ch.creditZ
    ? creditProxyRawStates(obs)
    : ch.oil
      ? derivedRawStateSeries(G1, obs)
      : rawStateSeries(ch.indicator, obs);
  const confirmed = confirmedSeries(raw, CONFIRM_CLOSES);

  // Fidelity guard: the streaming fold's tail must equal the production function.
  if (raw.length > 0 && confirmed[confirmed.length - 1] !== deriveConfirmedState(raw, CONFIRM_CLOSES)) {
    throw new Error(`[${ch.indicator.id}] confirmedSeries drifted from deriveConfirmedState`);
  }

  // raw/confirmed index k aligns to observation index VELOCITY_WINDOW + k. Valid for
  // all three branches: rawStateSeries, derivedRawStateSeries(G1), and creditProxyRawStates
  // each emit from VELOCITY_WINDOW (G1.derived.window === VELOCITY_WINDOW; the credit loop
  // starts at VELOCITY_WINDOW). If G1.derived.window ever diverges from VELOCITY_WINDOW this
  // misaligns. The credit warmup (252) only gates STATE to GREEN — it never shifts indexing.
  const state = new Map<string, State>();
  const level = new Map<string, number>();
  const dates: string[] = [];
  for (let k = 0; k < confirmed.length; k++) {
    const o = obs[VELOCITY_WINDOW + k]!;
    state.set(o.date, confirmed[k]!);
    level.set(o.date, o.value);
    dates.push(o.date);
  }
  return { dates, state, level };
}

// --- Stage-7 bottom-signal parameter sweep --------------------------------------
//
// Iterate the 3×3×3 = 27-combo grid (§3.3 / plan "/qimpag decisions — 2026-06-29 Stage 7")
// through the REAL parameterised bottom scorer (`bottomRawStateSeries` + the production
// `confirmedSeries` fold — same functions prod runs, so zero drift; no reimplementation),
// and emit `data/bottom_sweep.json` — the retired `harness.py` scored it against the NDX trough
// labels (harness deleted 2026-08-15, so the emit now has no consumer).
//
// Front/back legs are SAME-VENDOR closes-provider (`vixy` = ^VIX, `vix3m` = ^VIX3M; §3.1) — the FRED
// `vix` fixture is NOT used here (mixing vendors skews the near-1.0 ratio). The window params
// (highWin/lookback/ease*) stay at their defaults; only vixCap/rolloverK/backwardCut vary.

const VIX_CAP_GRID = [35, 40, 45];
const ROLLOVER_K_GRID = [0.8, 0.85, 0.9];
const BACKWARD_CUT_GRID = [0.95, 1.0, 1.05];

interface BottomSweepEntry {
  params: { vixCap: number; rolloverK: number; backwardCut: number };
  fires: string[];
}

/**
 * Rising-edge ISO dates where the parameterised scorer's CONFIRMED state ENTERS
 * BOTTOM-FORMING from a non-FORMING state (one fire per episode — NOT a single
 * first-ever date). `bottomRawStateSeries` aligns raw[k] → points[lookback + k], and
 * the generic `confirmedSeries` fold preserves that indexing, so confirmed[k] maps to
 * points[params.lookback + k].date.
 */
function bottomFires(points: ReturnType<typeof alignTermStructure>, params: BottomParams): string[] {
  const confirmed = foldConfirmed(bottomRawStateSeries(points, params), CONFIRM_CLOSES);
  const fires: string[] = [];
  let prev = "";
  for (let k = 0; k < confirmed.length; k++) {
    const st = confirmed[k]!;
    if (st === "BOTTOM-FORMING" && prev !== "BOTTOM-FORMING") {
      fires.push(points[params.lookback + k]!.date);
    }
    prev = st;
  }
  return fires;
}

function bottomSweep(): void {
  const points = alignTermStructure(loadCsv("vixy"), loadCsv("vix3m"));
  const sweep: BottomSweepEntry[] = [];
  for (const vixCap of VIX_CAP_GRID) {
    for (const rolloverK of ROLLOVER_K_GRID) {
      for (const backwardCut of BACKWARD_CUT_GRID) {
        const params: BottomParams = { ...BOTTOM_DEFAULTS, vixCap, rolloverK, backwardCut };
        sweep.push({ params: { vixCap, rolloverK, backwardCut }, fires: bottomFires(points, params) });
      }
    }
  }
  writeFileSync(join(DATA_DIR, "bottom_sweep.json"), JSON.stringify(sweep, null, 2) + "\n");
  const totalFires = sweep.reduce((n, e) => n + e.fires.length, 0);
  const span = points.length ? `${points[0]!.date}..${points[points.length - 1]!.date}` : "empty";
  console.log(`[sweep] ${sweep.length} configs over ${points.length} aligned days (${span}), ${totalFires} total fires`);
}

// --- T2.2/T3.2 warning-signal validation: default fire-lists + two param sweeps ----
//
// Framing (a) (§2 of the harness-validation plan): score each raw warning channel's own
// confirmed-state fire-list against NDX drawdowns via the SAME REAL scorer + `indicatorFires`
// every other channel uses (anti-drift: no reimplementation). Two channels:
//   • CG — copper/gold 20d ratio return (`ratioSpreadReadingSeries`, GEO-amplify prior T2.2).
//   • slow-calm — VIX duration-of-calm (`durationOfCalmRawStateSeries`, OK→WATCH floor prior T3.2).
// Emitted as a SEPARATE `warning_fires.json` so the shipped 8-channel `indicator_fires.json`
// stays byte-stable.

// Copper/gold sweep grid (§3): amber/red 20d-return bands, ANCHORED on the shipped
// (CG_AMBER_RET, CG_RED_RET) so the sweep ALWAYS contains the prior the scorer resolves ties
// to — anchoring on the live constants (not a hand-copied literal) means a band retune can't
// leave the grid stale. red is the DEEPER drop (more negative), so `red > amber` is invalid — skipped.
// The anchor only keeps the shipped prior IN the grid while red is the deeper drop — the
// `red > amber` skip below would otherwise drop the prior combo and re-trip sweeps.py's
// "prior missing from the warning sweep". Guard the invariant with a self-explaining throw.
if (CG_RED_RET > CG_AMBER_RET) {
  throw new Error(`CG_RED_RET (${CG_RED_RET}) must be <= CG_AMBER_RET (${CG_AMBER_RET}) — red is the deeper drop; else the sweep grid omits the shipped prior`);
}
const CG_AMBER_GRID = [CG_AMBER_RET, CG_AMBER_RET - 0.05, CG_AMBER_RET - 0.1];
const CG_RED_GRID = [CG_RED_RET, CG_RED_RET - 0.05, CG_RED_RET - 0.1];
// Slow-calm sweep grid (§3): calm-cut percentile × run-length minimum, centred on (0.5, 63).
// pctile MUST stay > VIX_LOW_PCTILE=0.1 or a sub-decile calm run is ~impossible (asserted below).
const SLOW_PCTILE_GRID = [0.4, 0.5, 0.6];
const SLOW_RUNMIN_GRID = [63, 126];

/**
 * Rising-edge ISO dates where a CONFIRMED state ENTERS an ELEVATED (≠GREEN) run from GREEN —
 * one fire per contiguous episode (mirrors `bottomFires` + `indicatorFires` episode semantics).
 * `dates[k]` is the observation date aligned to `confirmed[k]` by the caller.
 */
export function risingEdgeFires(confirmed: State[], dates: string[]): string[] {
  const fires: string[] = [];
  let prev: State = "GREEN";
  for (let k = 0; k < confirmed.length; k++) {
    const st = confirmed[k]!;
    if (st !== "GREEN" && prev === "GREEN") fires.push(dates[k]!);
    prev = st;
  }
  return fires;
}

/**
 * CG default confirmed-state series keyed by date. `ratioSpreadReadingSeries` already folds
 * CONFIRM_CLOSES (buildReadings), so each Reading's `.state` is the confirmed state and `.date`
 * its observation date — a fire-list drops out directly (§1 of Stage 3.1).
 */
export function copperGoldConfirmedByDate(): { dates: string[]; state: Map<string, State> } {
  const series = ratioSpreadReadingSeries(CG_IND, CG_DESCRIPTOR, loadCsv("copper"), loadCsv("gold"));
  const state = new Map<string, State>();
  const dates: string[] = [];
  for (const r of series) {
    state.set(r.date, r.state);
    dates.push(r.date);
  }
  return { dates, state };
}

/**
 * Slow-calm default confirmed-state series keyed by date. Unlike `confirmedByDate` (which aligns
 * raw[k] → obs[VELOCITY_WINDOW + k]), `durationOfCalmRawStateSeries` emits from index 0 (one state
 * per VIX close, no velocity offset), so raw/confirmed index k maps to `vix[k].date` directly. Runs
 * the same per-indicator fidelity guard as `confirmedByDate` (streaming fold tail == production).
 */
export function slowCalmConfirmedByDate(): { dates: string[]; state: Map<string, State> } {
  const vix = loadCsv("vix");
  const raw = durationOfCalmRawStateSeries(vix);
  const confirmed = confirmedSeries(raw, CONFIRM_CLOSES);
  if (raw.length > 0 && confirmed[confirmed.length - 1] !== deriveConfirmedState(raw, CONFIRM_CLOSES)) {
    throw new Error("[slow-calm] confirmedSeries drifted from deriveConfirmedState");
  }
  const state = new Map<string, State>();
  const dates: string[] = [];
  for (let k = 0; k < confirmed.length; k++) {
    const o = vix[k]!;
    state.set(o.date, confirmed[k]!);
    dates.push(o.date);
  }
  return { dates, state };
}

interface CopperGoldSweepEntry {
  params: { amber: number; red: number };
  fires: string[];
}

/**
 * Sweep CG_AMBER_GRID × CG_RED_GRID through the REAL parameterised `ratioSpreadReadingSeries`
 * (same fold prod runs, zero drift), skipping invalid `red > amber` combos, emitting rising-edge
 * fire dates per config to `data/copper_gold_sweep.json`. Mirrors `bottomSweep`.
 */
export function copperGoldSweepEntries(hg: Observation[], gc: Observation[]): CopperGoldSweepEntry[] {
  const sweep: CopperGoldSweepEntry[] = [];
  for (const amber of CG_AMBER_GRID) {
    for (const red of CG_RED_GRID) {
      if (red > amber) continue; // red = deeper drop (more negative) — a red looser than amber is invalid
      const readings = ratioSpreadReadingSeries(CG_IND, CG_DESCRIPTOR, hg, gc, amber, red);
      const confirmed = foldConfirmed(readings.map((r) => r.rawState), CONFIRM_CLOSES);
      sweep.push({ params: { amber, red }, fires: risingEdgeFires(confirmed, readings.map((r) => r.date)) });
    }
  }
  return sweep;
}

function copperGoldSweep(): void {
  const sweep = copperGoldSweepEntries(loadCsv("copper"), loadCsv("gold"));
  writeFileSync(join(DATA_DIR, "copper_gold_sweep.json"), JSON.stringify(sweep, null, 2) + "\n");
  const totalFires = sweep.reduce((n, e) => n + e.fires.length, 0);
  console.log(`[sweep] copper/gold ${sweep.length} configs, ${totalFires} total fires`);
}

interface SlowCalmSweepEntry {
  params: { pctile: number; runMin: number };
  fires: string[];
}

/**
 * Sweep SLOW_PCTILE_GRID × SLOW_RUNMIN_GRID through the REAL `durationOfCalmRawStateSeries`,
 * emitting rising-edge fire dates per config to `data/slow_calm_sweep.json`. Mirrors `bottomSweep`.
 */
function slowCalmSweep(): void {
  const vix = loadCsv("vix");
  const dates = vix.map((o) => o.date);
  const sweep: SlowCalmSweepEntry[] = [];
  for (const pctile of SLOW_PCTILE_GRID) {
    if (pctile <= VIX_LOW_PCTILE) throw new Error(`[slow-calm sweep] pctile ${pctile} must exceed VIX_LOW_PCTILE=${VIX_LOW_PCTILE}`);
    for (const runMin of SLOW_RUNMIN_GRID) {
      const confirmed = foldConfirmed(durationOfCalmRawStateSeries(vix, pctile, runMin), CONFIRM_CLOSES);
      sweep.push({ params: { pctile, runMin }, fires: risingEdgeFires(confirmed, dates) });
    }
  }
  writeFileSync(join(DATA_DIR, "slow_calm_sweep.json"), JSON.stringify(sweep, null, 2) + "\n");
  const totalFires = sweep.reduce((n, e) => n + e.fires.length, 0);
  console.log(`[sweep] slow-calm ${sweep.length} configs, ${totalFires} total fires`);
}

// --- Phase-2 candidate adjudication (2026-07-04): T10Y2Y · MOVE · backwardation (RATIO + DIFF) ---
//
// Framing (a): score each candidate's OWN
// confirmed-state fire-list against NDX drawdowns via the SAME REAL scorer + `indicatorFires` path every
// channel uses (anti-drift: no reimplementation). Four signals — backwardation splits into RATIO (VT scorer)
// vs DIFFERENCE (VIX−VIX3M level). Emitted as SEPARATE phase2_*.json artifacts so the shipped T2.2/T3.2 files
// (`warning_fires.json`, `indicator_fires.json`, `copper_gold_sweep.json`, `slow_calm_sweep.json`) stay
// byte-stable (emitters are purely additive).
//
// R6 (MOVE) and VT are NOT in INDICATORS (own price feeds, not the FRED loop), so they are
// imported DIRECTLY from the registry family files — the `ind()` helper searches INDICATORS and
// cannot resolve them. T10Y2Y + backwardation-DIFF have
// no shipped scorer, so they route through CG_IND-style replay-local stubs → the REAL rawStateSeries/classify
// (level bands, classify's strict `<`/`>` edges). RATIO uses the REAL parameterised ratioSpreadReadingSeries
// (asymmetric AMBER `≥` / RED `>` edges preserved — its edge convention differs from the DIFF stub's
// strict-both, documented so the RATIO↔DIFF comparison is honest).

// T10Y2Y stub: 10y−2y term spread, LOW direction (a FALLING/inverting spread is the risk),
// classify strict `<` on both level edges. Centre bands = defensible prior (amber 0.5 / red 0.0).
export const T10Y2Y_IND: Indicator = {
  id: "T10Y2Y",
  label: "10y−2y term spread",
  longLabel: "10y−2y term spread",
  series: "t10y2y",
  channel: "RATE",
  thresholds: { amberLevel: 0.5, redLevel: 0.0 },
  direction: "LOW",
  confirmer: false,
};

// backwardation-DIFF stub: VIX−VIX3M magnitude, HIGH direction (a RISING diff crossing into
// backwardation is the risk), classify strict `>` on both level edges. Centre = (amber −1 / red 0).
export const BWD_DIFF_IND: Indicator = {
  id: "backwardation-diff",
  label: "VIX−VIX3M term-structure difference",
  longLabel: "VIX−VIX3M term-structure difference",
  series: "vix-diff",
  channel: "COINCIDENT",
  thresholds: { amberLevel: -1, redLevel: 0 },
  direction: "HIGH",
  confirmer: false,
};

/**
 * Confirmed-state series keyed by date for a level-scored candidate that routes through the
 * REAL `rawStateSeries` (raw index k → obs[VELOCITY_WINDOW + k], the `confirmedByDate` alignment).
 * Folds CONFIRM_CLOSES via the streaming `confirmedSeries` and runs the same per-emitter fidelity
 * guard (tail == production `deriveConfirmedState`). Shared by the MOVE / T10Y2Y / DIFF builders.
 */
export function rawSeriesConfirmedByDate(
  indicator: Indicator,
  obs: Observation[],
): { dates: string[]; state: Map<string, State> } {
  const raw = rawStateSeries(indicator, obs);
  const confirmed = confirmedSeries(raw, CONFIRM_CLOSES);
  if (raw.length > 0 && confirmed[confirmed.length - 1] !== deriveConfirmedState(raw, CONFIRM_CLOSES)) {
    throw new Error(`[${indicator.id}] confirmedSeries drifted from deriveConfirmedState`);
  }
  const state = new Map<string, State>();
  const dates: string[] = [];
  for (let k = 0; k < confirmed.length; k++) {
    const o = obs[VELOCITY_WINDOW + k]!;
    state.set(o.date, confirmed[k]!);
    dates.push(o.date);
  }
  return { dates, state };
}

/** VIX−VIX3M difference series on the inner-joined dates (the backwardation-DIFF decision variable). */
export function backwardationDiffObs(vix: Observation[], vix3m: Observation[]): Observation[] {
  const { dates, a: v, b: t } = alignByDate(vix, vix3m);
  return dates.map((date, i) => ({ date, value: v[i]! - t[i]! }));
}

/** MOVE (R6) default confirmed-state series — the REAL registry R6 through rawStateSeries. */
export function moveConfirmedByDate(): { dates: string[]; state: Map<string, State> } {
  return rawSeriesConfirmedByDate(R6, loadCsv("move"));
}

/** T10Y2Y default confirmed-state series — the CG_IND-style stub through rawStateSeries. */
export function t10y2yConfirmedByDate(): { dates: string[]; state: Map<string, State> } {
  return rawSeriesConfirmedByDate(T10Y2Y_IND, loadCsv("t10y2y"));
}

/**
 * backwardation-RATIO default confirmed-state series — the REAL parameterised `ratioSpreadReadingSeries`
 * (VT scorer, VT_DESCRIPTOR) already folds CONFIRM_CLOSES (buildReadings), so each Reading's `.state` is the
 * confirmed state and `.date` its observation date — the CG default-builder shape.
 */
export function backwardationRatioConfirmedByDate(): { dates: string[]; state: Map<string, State> } {
  const series = ratioSpreadReadingSeries(VT, VT_DESCRIPTOR, loadCsv("vix"), loadCsv("vix3m"));
  const state = new Map<string, State>();
  const dates: string[] = [];
  for (const r of series) {
    state.set(r.date, r.state);
    dates.push(r.date);
  }
  return { dates, state };
}

/** backwardation-DIFF default confirmed-state series — the stub on VIX−VIX3M through rawStateSeries. */
export function backwardationDiffConfirmedByDate(): { dates: string[]; state: Map<string, State> } {
  return rawSeriesConfirmedByDate(BWD_DIFF_IND, backwardationDiffObs(loadCsv("vix"), loadCsv("vix3m")));
}

// --- Phase-2 sweep grids (§3 constants table) — every value pinned ---------------
// MOVE (HIGH upper-tail): centred on the shipped R6 bands (`src/registry.ts` — read them there,
// never restate the values here). red < amber is invalid.
// RE-CENTRED 2026-07-29 with the [USER] cut move (was [75,90,105] / [95,105,115] around the
// retired 90/105 pair; before that [100,120,140] / [140,150,160] around 120/150). The retired `harness.py`
// asserted the SHIPPED prior was a member of this grid (`score_warning_sweep`: "prior config …
// missing from the warning sweep"), so the grid tracks the registry — it is not free to stay
// where it was. The AMBER leg keeps the long-standing proportional shape (≈0.83×/1.0×/1.17× the
// shipped amber); the RED leg keeps the absolute ±10 step.
const MOVE_AMBER_GRID = [66, 79, 92];
const MOVE_RED_GRID = [85, 95, 105];
// backwardation-RATIO (HIGH, VT scorer): centred on the shipped VT bands (VT_AMBER_RATIO,
// VT_RED_RATIO — read them there, never restate the values here). red < amber is invalid.
const BWD_RATIO_AMBER_GRID = [0.9, VT_AMBER_RATIO, 1.0];
const BWD_RATIO_RED_GRID = [VT_AMBER_RATIO, VT_RED_RATIO, 1.05];
// T10Y2Y (LOW lower-tail): defensible prior (0.5, 0.0). red is the DEEPER/lower band, so red > amber
// is invalid (a red looser/higher than amber can't sit below it on the lower tail).
const T10Y2Y_AMBER_GRID = [1.0, 0.5, 0.25];
const T10Y2Y_RED_GRID = [0.25, 0.0, -0.25];
// backwardation-DIFF (HIGH): defensible prior (−1, 0). red < amber is invalid.
const BWD_DIFF_AMBER_GRID = [-2, -1, 0];
const BWD_DIFF_RED_GRID = [0, 1, 2];

interface LevelSweepEntry {
  params: { amberLevel: number; redLevel: number };
  fires: string[];
}
interface RatioSweepEntry {
  params: { amber: number; red: number };
  fires: string[];
}

/**
 * Sweep a level candidate's amber/red grid through the REAL `rawStateSeries` on stub descriptors
 * with varied `thresholds` (same fold prod runs → zero drift), skipping invalid combos per the
 * candidate's `skip` rule, emitting rising-edge fire dates per config. rawStateSeries emits from
 * VELOCITY_WINDOW, so confirmed[k] aligns to obs[VELOCITY_WINDOW + k].date. Mirrors `copperGoldSweepEntries`.
 */
function levelSweep(
  base: Indicator,
  obs: Observation[],
  amberGrid: number[],
  redGrid: number[],
  skip: (amber: number, red: number) => boolean,
): LevelSweepEntry[] {
  const alignedDates = obs.slice(VELOCITY_WINDOW).map((o) => o.date);
  const sweep: LevelSweepEntry[] = [];
  for (const amberLevel of amberGrid) {
    for (const redLevel of redGrid) {
      if (skip(amberLevel, redLevel)) continue;
      const stub: Indicator = { ...base, thresholds: { ...base.thresholds, amberLevel, redLevel } };
      const confirmed = foldConfirmed(rawStateSeries(stub, obs), CONFIRM_CLOSES);
      sweep.push({ params: { amberLevel, redLevel }, fires: risingEdgeFires(confirmed, alignedDates) });
    }
  }
  return sweep;
}

export function moveSweepEntries(obs: Observation[]): LevelSweepEntry[] {
  return levelSweep(R6, obs, MOVE_AMBER_GRID, MOVE_RED_GRID, (amber, red) => red < amber);
}
export function t10y2ySweepEntries(obs: Observation[]): LevelSweepEntry[] {
  return levelSweep(T10Y2Y_IND, obs, T10Y2Y_AMBER_GRID, T10Y2Y_RED_GRID, (amber, red) => red > amber);
}
export function bwdDiffSweepEntries(obs: Observation[]): LevelSweepEntry[] {
  return levelSweep(BWD_DIFF_IND, obs, BWD_DIFF_AMBER_GRID, BWD_DIFF_RED_GRID, (amber, red) => red < amber);
}

/**
 * Sweep the backwardation-RATIO amber/red grid through the REAL parameterised `ratioSpreadReadingSeries`
 * (VT scorer — asymmetric edges preserved), skipping invalid `red < amber` combos, emitting rising-edge
 * fire dates per config. Mirrors `copperGoldSweepEntries` (Reading.rawState → foldConfirmed → fires).
 */
export function bwdRatioSweepEntries(vix: Observation[], vix3m: Observation[]): RatioSweepEntry[] {
  const sweep: RatioSweepEntry[] = [];
  for (const amber of BWD_RATIO_AMBER_GRID) {
    for (const red of BWD_RATIO_RED_GRID) {
      if (red < amber) continue; // HIGH: red must sit at-or-above amber
      const readings = ratioSpreadReadingSeries(VT, VT_DESCRIPTOR, vix, vix3m, amber, red);
      const confirmed = foldConfirmed(readings.map((r) => r.rawState), CONFIRM_CLOSES);
      sweep.push({ params: { amber, red }, fires: risingEdgeFires(confirmed, readings.map((r) => r.date)) });
    }
  }
  return sweep;
}

/** Emit `phase2_sweeps.json = { "<candidate>": [{params, fires}, …] }` (one map file). */
function phase2Sweeps(): void {
  const vix = loadCsv("vix");
  const vix3m = loadCsv("vix3m");
  const sweeps: Record<string, Array<LevelSweepEntry | RatioSweepEntry>> = {
    MOVE: moveSweepEntries(loadCsv("move")),
    T10Y2Y: t10y2ySweepEntries(loadCsv("t10y2y")),
    "backwardation-ratio": bwdRatioSweepEntries(vix, vix3m),
    "backwardation-diff": bwdDiffSweepEntries(backwardationDiffObs(vix, vix3m)),
  };
  writeFileSync(join(DATA_DIR, "phase2_sweeps.json"), JSON.stringify(sweeps, null, 2) + "\n");
  for (const [name, entries] of Object.entries(sweeps)) {
    const totalFires = entries.reduce((n, e) => n + e.fires.length, 0);
    console.log(`[sweep] phase2 ${name} ${entries.length} configs, ${totalFires} total fires`);
  }
}

// --- Indicator-value audit (2026-07-02, qimpag) — Stage B/C emitters -------------
//
// Stage B of the indicator value audit:
//   • indicator_fires.json — per-indicator rising-edge ELEVATED episodes, labelled per
//     (market, mode) with windowed forward drawdown + NDX-cell buckets.

type SeriesEntry = {
  ch: Channel;
  dates: string[];
  state: Map<string, State>;
  level: Map<string, number>;
};

// --- Stage B: per-indicator fire-list -------------------------------------------
interface IndicatorFire {
  entryDate: string;
  days: number;
  peakState: State;
  /** Fwd drawdown per market over each MODE's window from the entry close (null = still-open). */
  drawdown: Record<Market, Record<ModeName, number | null>>;
  /** Code-emitted mode buckets for the NDX cells (SPX/EAFE stay raw-only this slice). */
  modeBuckets: Record<ModeName, Bucket | null>;
}

/**
 * Rising-edge ELEVATED (≠GREEN) episodes of one indicator's CONFIRMED state, one row per
 * contiguous run, labelled per (market, mode) with the worst forward drawdown over that
 * mode's window from the entry close, and bucketed (NDX cells) at that mode's edges. This
 * is the Stage-B "look": eyeball whether an indicator's fires cluster at real drawdowns of
 * each mode's severity or in calm years (shallow/none).
 */
function indicatorFires(
  dates: string[],
  state: Map<string, State>,
  labels: Record<Market, Observation[]>,
): IndicatorFire[] {
  const fires: IndicatorFire[] = [];
  let open: { entryDate: string; days: number; peak: State } | null = null;
  const close = (o: NonNullable<typeof open>): IndicatorFire => {
    const drawdown = {} as IndicatorFire["drawdown"];
    for (const mkt of MARKET_NAMES) {
      const per = {} as Record<ModeName, number | null>;
      for (const mn of MODE_NAMES) per[mn] = maxForwardDrawdown(labels[mkt], o.entryDate, MODES[mn].windowTd);
      drawdown[mkt] = per;
    }
    const modeBuckets = {} as IndicatorFire["modeBuckets"];
    for (const mn of MODE_NAMES) modeBuckets[mn] = bucketDrawdown(drawdown.NDX[mn], MODES[mn]);
    return { entryDate: o.entryDate, days: o.days, peakState: o.peak, drawdown, modeBuckets };
  };
  for (const d of dates) {
    const st = state.get(d)!;
    if (st !== "GREEN") {
      if (open === null) open = { entryDate: d, days: 1, peak: st };
      else {
        open.days++;
        if (STATE_RANK[st] > STATE_RANK[open.peak]) open.peak = st;
      }
    } else if (open !== null) {
      fires.push(close(open));
      open = null;
    }
  }
  if (open !== null) fires.push(close(open));
  return fires;
}

/**
 * VT (VIX term structure) SeriesEntry — a two-fixture backwardation-RATIO indicator scored bespoke by
 * the unified ratio/spread scorer (`ratioSpreadReadingSeries` over VT_DESCRIPTOR already folds CONFIRM_CLOSES, so each Reading's `.state` is the
 * confirmed state). It can't ride the single-fixture `confirmedByDate` path that CHANNELS rows use, so
 * it's built out-of-loop and appended to the series, COINCIDENT beside R5/R6, matching live
 * production (`scoreVixTermIndicator`, promoted 2026-07-04). `level` is the
 * VIX/VIX3M ratio, carried for Reading fidelity only (indicatorFires reads `.state`).
 */
function vixTermSeriesEntry(): SeriesEntry {
  const readings = ratioSpreadReadingSeries(VT, VT_DESCRIPTOR, loadCsv("vix"), loadCsv("vix3m"));
  const state = new Map<string, State>();
  const level = new Map<string, number>();
  const dates: string[] = [];
  for (const r of readings) {
    state.set(r.date, r.state);
    level.set(r.date, r.level);
    dates.push(r.date);
  }
  return { ch: { indicator: VT, fixture: "vix", oil: false }, dates, state, level };
}

export function buildSeries(): SeriesEntry[] {
  return [...CHANNELS.map((ch) => ({ ch, ...confirmedByDate(ch) })), vixTermSeriesEntry()];
}

function main(): void {
  const series: SeriesEntry[] = buildSeries();

  // Per-market forward-drawdown label series.
  const labels = Object.fromEntries(
    MARKET_NAMES.map((mkt) => [mkt, loadCsv(MARKET_FIXTURES[mkt])]),
  ) as Record<Market, Observation[]>;

  // --- Stage B: per-indicator fire-lists ---
  const indicatorFireLists: Record<string, IndicatorFire[]> = {};
  for (const s of series) {
    indicatorFireLists[s.ch.indicator.id] = indicatorFires(s.dates, s.state, labels);
  }
  writeFileSync(join(DATA_DIR, "indicator_fires.json"), JSON.stringify(indicatorFireLists, null, 2) + "\n");
  const fireSummary = Object.entries(indicatorFireLists)
    .map(([id, f]) => `${id}=${f.length}`)
    .join(" ");
  console.log(`[stageB] per-indicator fire episodes: ${fireSummary}`);
  const allFires = Object.values(indicatorFireLists).flat();
  const modeSummary = MODE_NAMES.map((mn) => {
    const n = (b: Bucket) => allFires.filter((f) => f.modeBuckets[mn] === b).length;
    return `${mn}=${n("caught")}/${n("minor")}/${n("noise")}`;
  }).join(" ");
  console.log(`[stageB] NDX-cell buckets caught/minor/noise per mode: ${modeSummary}`);

  // --- T2.2/T3.2 warning-signal validation (framing (a) default fire-lists) ---
  // Feed the two raw warning channels through the SAME `indicatorFires` every other channel
  // uses, so they inherit the identical rising-edge-ELEVATED episode + per-(market, mode)
  // drawdown-bucket shape. Kept in a SEPARATE artifact so `indicator_fires.json` stays byte-stable.
  const cg = copperGoldConfirmedByDate();
  const slowCalm = slowCalmConfirmedByDate();
  const warningFires: Record<string, IndicatorFire[]> = {
    CG: indicatorFires(cg.dates, cg.state, labels),
    "slow-calm": indicatorFires(slowCalm.dates, slowCalm.state, labels),
  };
  writeFileSync(join(DATA_DIR, "warning_fires.json"), JSON.stringify(warningFires, null, 2) + "\n");
  console.log(`[warning] CG=${warningFires.CG!.length} slow-calm=${warningFires["slow-calm"]!.length} fire episode(s)`);

  // --- Phase-2 candidate adjudication (framing (a) default fire-lists) ---
  // Feed each candidate's confirmed-state series through the SAME `indicatorFires` every channel
  // uses (identical rising-edge-ELEVATED episode + per-(market, mode) drawdown-bucket shape, so the
  // harness fire loaders read it for free). SEPARATE artifact — shipped files stay byte-stable.
  const t10y2y = t10y2yConfirmedByDate();
  const move = moveConfirmedByDate();
  const bwdRatio = backwardationRatioConfirmedByDate();
  const bwdDiff = backwardationDiffConfirmedByDate();
  const phase2Fires: Record<string, IndicatorFire[]> = {
    T10Y2Y: indicatorFires(t10y2y.dates, t10y2y.state, labels),
    MOVE: indicatorFires(move.dates, move.state, labels),
    "backwardation-ratio": indicatorFires(bwdRatio.dates, bwdRatio.state, labels),
    "backwardation-diff": indicatorFires(bwdDiff.dates, bwdDiff.state, labels),
  };
  writeFileSync(join(DATA_DIR, "phase2_warning_fires.json"), JSON.stringify(phase2Fires, null, 2) + "\n");
  console.log(
    `[phase2] T10Y2Y=${phase2Fires.T10Y2Y!.length} MOVE=${phase2Fires.MOVE!.length} ` +
      `backwardation-ratio=${phase2Fires["backwardation-ratio"]!.length} ` +
      `backwardation-diff=${phase2Fires["backwardation-diff"]!.length} fire episode(s)`,
  );

  bottomSweep();
  copperGoldSweep();
  slowCalmSweep();
  phase2Sweeps();
}

// Run only on direct exec; importing (e.g. replay.test.ts) must not trigger the
// fixture read + data/*.json artifact writes. Matches `run.ts`'s own `invokedDirectly` guard.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
