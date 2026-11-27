/**
 * GET /api/indicators — per-indicator metadata (openapi.yaml `getIndicators`).
 * Static config (thresholds, chart spec) plus F7's vintage-dependent CAPE display
 * bands read from the stored history. Vercel Node function (Web-handler signature).
 * Serves through `serveRedactable`: values read off a licensed series (the CAPE band cuts, the
 * HY-OAS bps report) are redacted in the public response (`redactIndicators`); hand-set thresholds/specs stay.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { CHART_ONLY_IDS, CHART_ONLY_INDICATORS } from "../src/registry-composite.js";
import { type Indicator, type DerivedView } from "../src/domain-types.js";
import { cardGroupOf } from "../src/families.js";
import { MEMBER_WEIGHT } from "../src/danger-ladder.js";
import { EARLY_WARN_MEMBERS } from "../src/t1dial.js";
import { RS_LEG_OF } from "../src/registry-price.js";
import { resolveBands } from "../src/threshold-config.js";
import { derivedFiresHighward } from "../src/scorers-core.js";
// Chart rail (Stage 4) — the WHOLE family chart-spec dispatch (`buildFamilyChart`,
// src/chart-rail.ts): every former id-branch of this file's chart builder lives there
// since slice 4.4; `buildChart` below only stamps the window policy on top.
import { buildFamilyChart, type CapeCardCuts } from "../src/chart-rail.js";
import { CHART_PARAMS_OF, DETAIL_WINDOW_DAYS } from "../src/family-descriptor-rows.js";
import { expandingPercentile } from "../src/percentile.js";
import { getStore, type SeriesPoint, type ReadStore } from "../src/store.js";
import type {
  BpsSensitivity,
  BpsSensitivityPoint,
  ChartSpec,
  IndicatorMeta,
} from "../src/api/types.js";
// EW-R1 Stage 4.1 (EW-7): the committed measurement output is the SINGLE source of the
// bps sensitivity report — imported, never re-typed, so the wire cannot drift from the
// published vintage. Static JSON import (the config.json / threshold-config.json pattern).
import F1_CUTS from "../scripts/backtest/f1_cuts.json" with { type: "json" };
import { rejectUnknownParams, serveRedactable } from "../src/api/http.js";
import { isLicensedId, isLicensedSource } from "../src/licensed.js";
import { computeCapeValuation, type CapeObs } from "../src/valuation.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

// F7/CAPE display bands (2026-08-11 `[USER]`; replaced the 30y-mean line): the current expanding-
// percentile quantiles of CAPE's own stored monthly history, one per `valueFrom:"capePct"` entry
// on `CHART_PARAMS_OF.F7` (p80 amber / p95 red — declared THERE, never restated here). The cut is
// `expandingPercentile(...).at(-1)` — strict-prefix, so today's month never sets its own line, and
// NaN under PCT_MIN_OBS finite months. Staleness reuses `computeCapeValuation`'s degrade verdict:
// a degraded read (absent/short/lagging) ⇒ null ⇒ NO bands ⇒ F7 falls through to the value-only
// gray path — never a bogus line.
const CAPE_PCT_READ = 2400; // full monthly CAPE history (1881→ ≈1,740 rows)
export const STORED_COMPANION_HORIZON = "2015-01-01"; // lab.js ≥2015 companion-eligibility cutoff (P4)
const EMPTY_BULK: Map<string, SeriesPoint[]> = new Map(); // degrade result for the companion bulk read

// D2 engine role — derived from the SAME registry/engine sets the scorers run on, never a
// hand-typed id list. EW covers the detectors AND their RS_LEG_OF gate legs; checked BEFORE
// MEMBER_WEIGHT because DB_SMH still holds a dead weight row (danger-ladder.ts: never looked up).
const EW_SEAT_IDS: ReadonlySet<string> = new Set(
  EARLY_WARN_MEMBERS.flatMap((id) => [id, RS_LEG_OF[id]!]),
);
function roleOf(id: string): IndicatorMeta["role"] {
  if (CHART_ONLY_IDS.includes(id)) return "chart-only";
  if (EW_SEAT_IDS.has(id)) return "early-warning";
  if (id in MEMBER_WEIGHT) return "member";
  return "context";
}
async function capeBandLevels(store: ReturnType<typeof getStore>, warn: (...args: unknown[]) => void): Promise<CapeCardCuts | null> {
  const series: CapeObs[] = await store.getSeries("F7", CAPE_PCT_READ).catch((err: unknown) => {
    warn("[indicators] F7 read failed - serving no CAPE bands:", err);
    return [];
  });
  const cape = computeCapeValuation(series, isoDay(new Date()));
  if (cape.degraded) return null;
  const values = [...series].sort((a, b) => (a.date < b.date ? -1 : 1)).map((o) => o.value);
  const cuts: Partial<Record<"amber" | "red", number>> = {};
  for (const b of CHART_PARAMS_OF.F7?.displayBands ?? []) {
    if (b.valueFrom !== "capePct" || b.p == null) continue;
    const cut = expandingPercentile(values, b.p).at(-1);
    if (cut == null || !Number.isFinite(cut)) return null; // under the min-obs floor — no bands
    cuts[b.level] = cut;
  }
  return cuts;
}

/** The Vercel entry point: request-only, so a platform-passed 2nd argument can never be
 *  mistaken for a store. Store use goes through `handle`'s thunk (rung 8a). */
export async function GET(request?: Request): Promise<Response> {
  const env = readEnv();
  return handle(() => getStore("ro", env), request);
}

/** `handle`'s seam: `warn` = the degrade-log sink. */
type IndicatorsSeams = { warn?: (...args: unknown[]) => void };

/** The ids whose chart draws `valueFrom:"capePct"` bands — cut values read off the id's OWN stored history. */
const CAPE_PCT_IDS: ReadonlySet<string> = new Set(
  Object.entries(CHART_PARAMS_OF)
    .filter(([, p]) => (p.displayBands ?? []).some((b) => b.valueFrom === "capePct"))
    .map(([id]) => id),
);
const SERVED_BY_ID = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => [i.id, i]));

/** The redacted response body: a licensed id's history-read band cuts dropped (its chart rebuilt cut-less — the same
 *  value-only spec a degraded CAPE read serves) and a `bpsSensitivity` report over a licensed series omitted;
 *  every hand-set threshold/spec field stays. Pure — `serveRedactable`'s redact. */
function redactIndicators(raw: IndicatorMeta[]): IndicatorMeta[] {
  return raw.map((m) => {
    const ind = SERVED_BY_ID.get(m.id);
    const cut = ind && CAPE_PCT_IDS.has(m.id) && isLicensedId(m.id) ? { ...m, chart: buildIndicatorChart(ind) } : m;
    if (!cut.bpsSensitivity || !isLicensedSource(cut.bpsSensitivity.series)) return cut;
    const { bpsSensitivity: _report, ...rest } = cut;
    return rest;
  });
}

// The injectable seam (rung 8a): tests pass `() => new InMemoryStore()`. A THUNK, not a Store,
// resolved AFTER the param check — an unknown-param 400 never touches Supabase env.
export async function handle(storeOf: () => ReadStore, request?: Request, opts: IndicatorsSeams = {}): Promise<Response> {
  if (request?.url) {
    const params = new URL(request.url).searchParams;
    const unknown = rejectUnknownParams(params, []);
    if (unknown) return unknown;
  }
  return serveRedactable(indicatorsBody(storeOf, opts.warn ?? console.warn), redactIndicators);
}

/** The FULL `/indicators` body (every history-read cut in place). Exported so a suite asserting on the redactable
 *  fields reads them before `handle`'s response rule. */
export async function indicatorsBody(storeOf: () => ReadStore, warn: (...args: unknown[]) => void): Promise<IndicatorMeta[]> {
  // F7's CAPE display bands are vintage-dependent (they read the stored monthly history),
  // so this otherwise-static metadata route reads the DB once via `capeBandLevels`. A DB blip
  // degrades to no bands rather than 500-ing the whole route.
  const store = storeOf();
  // F1's MEASURED EVT level pair used to be resolved here and drawn as a second (dotted) band
  // pair. RETIRED 2026-07-23 (`[USER]`): the pair sat permanently above F1's hand-set 3.0/3.2
  // priors, so it could never be the leg that coloured a bar, and `CALIB_MAP.F1.evtLevel` is now
  // `false` — `resolveCuts` returns no `evtAmber`/`evtRed` for F1 at all. F1's remaining drawable
  // legs (the operative level pair, the 30d velocity pair) are both `threshold` bands; the
  // regime-z leg has no HY-OAS level and is tagged under the ribbon as before.
  // CHART-ONLY ids ride the TAIL of the served list (2026-07-31).
  // They are deliberately outside `ALL_INDICATORS` — so they stay out of
  // `ID_SETS`, the goldens, every family table and every roll-up — but without a meta here the
  // Dashboard draws no card and no detail chart for them, which is the half of the ruling
  // ("streak history + a chart") that `/api/series?id=VTP` alone does not deliver: renderZoneC
  // only paints ids that have BOTH a served meta and a `cardGroupOf` family. Everything below is
  // the SAME builder every scored id runs through — no branch, no special-casing: with `thresholds:
  // {}` and no `derived` the chart rail lands on its context-only spec and `resolveCuts`
  // falls through to convention, exactly as for any unmapped id.
  const served: readonly Indicator[] = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS];
  const ids = served.map((i) => i.id);
  // P4 rides this payload via ONE bulk read (never a per-id loop): `companionAnchor` kills lab.js's ≥2015 62-probe sweep.
  const [capeCuts, companionAnchor] = await Promise.all([
    capeBandLevels(store, warn),
    store.getSeriesBulk(ids, { limit: 1, range: { to: STORED_COMPANION_HORIZON } }).catch((err: unknown) => {
      warn("[indicators] companion-anchor bulk read failed - serving no companionAnchorDate:", err);
      return EMPTY_BULK;
    }),
  ]);
  const meta: IndicatorMeta[] = served.map((i) => {
    // Resolve the derived band lines ONCE (config seam) so `derived` on the meta and the
    // chart's `source:"derived"` band values are single-sourced — a config edit can't move
    // one without the other (Case 2's ribbon-vs-line invariant, preserved into the spec).
    const derived = scaleDerived(i.derived, i.id);
    const bpsSensitivity = bpsSensitivityFor(i.series);
    const companionAnchorDate = companionAnchor.get(i.id)?.[0]?.date;
    return {
    id: i.id,
    label: i.label,
    series: i.series,
    channel: i.channel,
    // Dashboard card grouping: panel family (union US ∪ GLOBAL membership) first, then the
    // display-only overlay (CARD_ONLY_GROUPS: VIX/VIX3M→volatility, DB_SMH/DB_XLK→trend, F7→valuation,
    // SPY/DEXUSEU/SP500IT/LEGP_*→pension-drawdown). NEVER `familyOf` here — that would leave the
    // display-only legs cardless. `undefined` only for ids in no panel family AND no overlay.
    family: cardGroupOf(i.id),
    // Materialize the documented "%" default (indicators.ts) at the wire edge so
    // the UI can format levels; an explicit "" (VIX/rate/ratio) stays unitless; "€"/"$" are currency prefixes.
    unit: i.unit ?? "%",
    // Threshold cut-points + polarity back the Zone D detail chart's bands.
    thresholds: i.thresholds,
    direction: i.direction,
    // The feed's RELEASE schedule — how often it PUBLISHES, NOT the grid its observations sit on.
    // It does not decide a per-reading unit word on its own: every consumer resolves
    // `obsCadence ?? cadence` (the field two below). Omitted for daily series so the wire stays
    // lean (absent = daily).
    cadence: i.cadence,
    // The span the `delta20` column carries for THIS id, in observations. Passed through raw:
    // absent ⇒ the global VELOCITY_WINDOW (20), the same absent-means-default convention
    // `cadence` uses one line up, so the wire stays lean for the majority that take the default
    // and the FE has one rule for both fields. Which ids carry one: `registry.ts`.
    velocityWindow: i.velocityWindow,
    // `"relative"` ⇒ that column is a FRACTION of the base (the card prints it as a %); absent ⇒ absolute Δ.
    velocityMode: i.velocityMode,
    // The OBSERVATION grid that span steps over, passed through raw (absent ⇒ fall back to
    // `cadence`). Without it a weekly-RELEASED, business-day-OBSERVED id (the FRED H.10 and EIA
    // families) has its TRADING-day change captioned in weeks — a ~5× overstatement. Which ids
    // declare it: `registry.ts`; the resolved word per id is pinned in `public/velocity-span.test.js`.
    obsCadence: i.obsCadence,
    // Decision-variable descriptor for bespoke scorers (F4/G1/NVDA/F5); absent
    // for level/velocity indicators (the detail chart falls back to thresholds).
    // Resolve amber/red through the SAME config seam the SCORER uses (F6/F8), so the
    // drawn band line tracks the scored band — else a config edit moves the ribbon but
    // leaves the displayed line/number frozen at the raw prior.
    derived,
    // Declarative detail-chart spec (Case 1, Stage 2). Built from the SAME resolved config
    // (derived bands via the shared `derived` above; VT via the scorer's ratio constants),
    // so the spec-driven renderer (Stage 5) reproduces today's bespoke output. Additive;
    // the FE ignores it until then.
    chart: buildChart(i, derived, capeCuts),
    // EW-7: the regime-dependence of a PERCENTILE cut, made legible. Keyed off the
    // measured SERIES id, not a hardcoded "F1" — if F1's series is ever repointed the
    // field drops rather than mislabelling another series' distribution as F1's.
    ...(bpsSensitivity ? { bpsSensitivity } : {}),
    // Chart-only marker for the card/detail surfaces (`IndicatorMeta.chartOnly`). Derived from
    // the registry set, never a hand-typed id list, so a second chart-only id inherits it.
    ...(CHART_ONLY_IDS.includes(i.id) ? { chartOnly: true as const } : {}),
    // D2 — which engine seat the id holds. Served for clients; the detail tab stopped rendering an
    // "In the engine." line off it 2026-09-12 (slice 2b) — kept on the wire, contract unchanged.
    role: roleOf(i.id),
    ...(companionAnchorDate ? { companionAnchorDate } : {}),
    };
  });
  // Vintage-dependent: `serveRedactable`'s default headers are `VINTAGE_HEADERS`, so a calib publish surfaces on the
  // cron's purge (was CACHE_STATIC deploy-only, which would have hidden a publish).
  return meta;
}

/**
 * EW-R1 Stage 4.1 / EW-7 — "what does the shipped percentile mean in bps?", answered for
 * today, 2015 and 2019 off the committed measurement output. Report-only: NOTHING scores
 * off this, and the shipped cuts stay the ones in `calibration.json`.
 *
 * Why it exists: F1's Amber/Red are now the p66/p90 of an UNCONDITIONAL trailing-5y HY-OAS
 * distribution. A percentile is regime-relative, so the same p66 that is ~380bps on today's
 * window was ~555bps on a 2015 window and ~466bps on a 2019 one. Publishing only today's
 * bps invites reading the cut as a fixed constant; the ladder makes the regime-dependence
 * impossible to miss.
 *
 * Keyed on the SERIES id, so it attaches to whichever indicator actually carries the
 * measured series rather than to a hardcoded id. Returns `undefined` for every other
 * series — hence the optional field. The bps keys are derived from the published
 * percentiles (`p66_bps` from 0.66), so re-publishing at a different percentile pair
 * cannot silently keep serving the old columns: the lookup misses and the field drops.
 */
function bpsSensitivityFor(series: string): BpsSensitivity | undefined {
  if (series !== F1_CUTS.series) return undefined;
  const { amber, red } = F1_CUTS.percentiles;
  const bpsKey = (pct: number) => `p${Math.round(pct * 100)}_bps`;
  const points: BpsSensitivityPoint[] = [];
  for (const w of F1_CUTS.spliced.asOfLadder) {
    const level = w.level as unknown as Record<string, number | undefined>;
    const amberBps = level[bpsKey(amber)];
    const redBps = level[bpsKey(red)];
    if (amberBps === undefined || redBps === undefined) return undefined;
    points.push({ window: w.window, start: w.start, asOf: w.end, n: w.level.n, amberBps, redBps });
  }
  return {
    source: "scripts/backtest/f1_cuts.json",
    series: F1_CUTS.series,
    leg: "level",
    percentiles: { amber, red },
    points,
  };
}

/**
 * Resolve a `derived` descriptor's amber/red band lines through the config seam
 * (`resolveBands`), mirroring what the SCORER does (F6 scoreRelStrengthBreak / F8
 * scoreMemGate). Keeps the drawn line in lock-step with the scored band; a no-op for an
 * unconfigured id (every indicator except a deliberately-tuned F6/F8). `null` legs stay
 * null unless an absolute override supplies a number.
 */
function scaleDerived(d: DerivedView | undefined, id: string): DerivedView | undefined {
  if (!d) return d;
  const { amber, red } = resolveBands(id, d.amber, d.red, derivedFiresHighward(d));
  return amber === d.amber && red === d.red ? d : { ...d, amber, red };
}

/**
 * Public convenience: build one indicator's `chart` spec exactly as the GET
 * handler does (resolving derived bands through `scaleDerived` first), so tests
 * (Case 1 Stage 3/4) can construct a realistic `meta.chart` per id without a
 * store. Single-sources the category logic with the wire path above.
 */
export function buildIndicatorChart(i: Indicator): ChartSpec {
  return buildChart(i, scaleDerived(i.derived, i.id));
}

// DATE-anchored detail window (ChartSpec.fromDays). These ids are sampled differently (F3 is
// WEEKLY; the rest daily) or have mid/end gaps, so a trading-day COUNT window (`window`) lands
// each on a different calendar start. A shared calendar-days lookback anchors them all to one
// start date. Add an id here to enrol it; the client injects `fromDate = today −
// DETAIL_WINDOW_DAYS` and the renderer slices at it.
// ⚠ The span is NOT decided here. `DETAIL_WINDOW_DAYS` is the calendar-day form of the ONE shared
// span (`DETAIL_WINDOW_CONFIG`, family-descriptor-rows.ts) — it used to be a hand-typed 700, which made
// an aligned id (F1, F13) cover a different amount of history than a count-window id on the SAME
// leg top-5 stack. This set now chooses only WHICH ids anchor by date, never how far back.
const ALIGNED_WINDOW_IDS = new Set(["F1", "F3", "F13", "SPY", "VT", "DISP"]);

/** Wraps the chart rail's `buildFamilyChart` (src/chart-rail.ts — since slice 4.4 the WHOLE
 *  dispatch lives there), stamping the shared date-anchored `fromDays` on the aligned-start
 *  ids (single injection point, so the rail's routes stay unaware of the window policy). */
function buildChart(
  i: Indicator,
  derived: DerivedView | undefined,
  capeCuts?: CapeCardCuts | null,
): ChartSpec {
  const spec = buildFamilyChart(i, derived, capeCuts);
  return ALIGNED_WINDOW_IDS.has(i.id) ? { ...spec, fromDays: DETAIL_WINDOW_DAYS } : spec;
}
