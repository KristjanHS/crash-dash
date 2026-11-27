/**
 * openapi ↔ TS DTO contract (P3).
 *
 * The DTOs in types.ts are now re-exports of the store domain types, so TS and
 * the store can't drift. `openapi.yaml` is the one remaining *separate* copy of
 * each payload shape — this test pins it to the TS side so the YAML can't
 * silently fall out of sync.
 *
 * Dep-free on purpose (no js-yaml / ajv — the project keeps its devDep set
 * minimal): each sample below is typed against its DTO, so a field added to the
 * TS type but missing from the sample is a *compile* error here; the test then
 * asserts the openapi schema's `required` set matches the sample's keys (modulo
 * documented optionals). Drift in either direction fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Channel, Direction, DerivedView, State, Thresholds } from "../domain-types.js";
import { ALERT_RANK, type AlertLevel } from "../ladder.js";
import { PENSION_DIP, PENSION_CORRECTION, PENSION_BEAR } from "../pension.js";
import { ACCEL_AMBER_PCTILE, ACCEL_RED_PCTILE, VIX_LOW_PCTILE, NEAR_HIGH_FRAC } from "../slow.js";
import { VT_AMBER_RATIO, VT_RED_RATIO } from "../family-descriptor-rows.js";
import {
  computeFamilyPanel,
  computeFamilyPanelFromStates,
  US_FAMILIES,
  GLOBAL_FAMILIES,
  DASHBOARD_FAMILIES,
  SIGNAL_OF,
  FAMILY_OF_SIGNAL,
  LADDER,
  PER_LEG_ONLY_MEMBERS,
  type LabResponse,
  type LabBand,
  type LabBandFloor,
  type LabBandMember,
  type OverlayView,
} from "../families.js";
import { CONFIRM_CLOSES } from "../domain-types.js";
import { DUAL_AXIS_IDS, LEG_ORDER } from "../domain-legs.js";
import { legCloseId } from "../scoreboard.js";
import {
  EQUITY_PCT,
  EXPOSURE_THRESHOLDS,
  ARM_ROC_APPROACH_BP,
  FIRE_MA_APPROACH_SPREAD,
  type Posture,
} from "../exposure.js";
import { GT } from "../registry-composite.js";
import { resolvedDerivedBands } from "../scorers-core.js";
import { FALL_SHAPE_CONFIDENCE_VALUES, type FallShape, type FallShapeConfidence } from "../v-bear.js";
import { computeT1Dial, LEG_WEIGHTED_IDS, NO_ARM_FAMILIES } from "../t1dial.js";
import { computeField, DANGER_CUTS, PILLAR_MEMBER_IDS } from "../danger-engine.js";
import {
  DIAL_FAMILIES,
  SUPER_GROUPS,
  SUPER_GROUP_OF,
  MEMBER_RELEVANCE,
  MEMBER_WEIGHT,
  MEMBER_LABEL,
  CLUSTERS,
  RERISK_CONFIRM,
  RERISK_DWELL_DAYS,
} from "../danger-ladder.js";
import {
  CONC_THRESHOLD,
  CONC_WEIGHT,
  DERISK_DEADBAND,
  RERISK_DEADBAND,
} from "../danger-engine.js";
import type {
  AlertRecordDTO,
  BpsSensitivity,
  BpsSensitivityPoint,
  CellObservedDTO,
  HeldMarkDTO,
  ChartAxis,
  ChartBand,
  ChartGate,
  ChartSeries,
  ChartSpec,
  DangerModel,
  ExposureReplayEpisodeDTO,
  ExposureReplayPointDTO,
  ExposureReplayResponse,
  ExposureResponse,
  FamilyMeta,
  FieldResultDTO,
  IndicatorMeta,
  LegRowDTO,
  ReadingDTO,
  ReplayCompanionResponse,
  ReplayCoverageDTO,
  ReplayPointDTO,
  ReplayResponseDTO,
  CoverageDegradeDTO,
  CoverageMarkDTO,
  SeriesResponse,
  SignalCellDTO,
  StatusResponse,
} from "./types.js";
import type { SeriesPoint } from "../store.js";

const OPENAPI = readFileSync(fileURLToPath(new URL("../../openapi.yaml", import.meta.url)), "utf8");

/**
 * Lines of one `components.schemas.<name>` block — from `    <name>:` up to the
 * next 4-space-indented key (the following schema) or any dedent out of the
 * schemas map. The schemas here use single-line flow arrays for `required`, so a
 * line grab + bracket parse is enough; no YAML parser needed.
 */
function schemaBlock(name: string): string {
  const lines = OPENAPI.split("\n");
  const start = lines.indexOf(`    ${name}:`);
  if (start < 0) throw new Error(`openapi.yaml has no schema named ${name}`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === undefined) break;
    if (l.trim() === "") continue;
    if (/^ {0,4}\S/.test(l)) break; // next schema (4-space) or shallower dedent
    body.push(l);
  }
  return body.join("\n");
}

// NB: assumes `required:` is a single-line flow array (`[a, b]`) — every schema
// in openapi.yaml uses that form. Block-sequence syntax would parse as [] and
// trip the `length > 0` sanity check in the test below.
function requiredOf(name: string): string[] {
  const list = schemaBlock(name).match(/required:\s*\[([^\]]*)\]/)?.[1];
  return list ? list.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// Property KEYS declared under a schema block's `properties:` map — the 8-space
// keys directly beneath it (nested keys sit at ≥10 spaces, so a fixed 8-space
// match skips them). Lets the test check that each self-declared `optional` name
// is REALLY a documented property, not just an unchecked string in the CASES table.
function propertiesOf(name: string): string[] {
  const lines = schemaBlock(name).split("\n");
  const at = lines.findIndex((l) => /^ {6}properties:/.test(l));
  if (at < 0) return [];
  const keys: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === undefined || /^ {0,6}\S/.test(l)) break; // dedent out of the properties map
    const m = l.match(/^ {8}([A-Za-z][\w-]*):/);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

// --- Typed samples (TS enforces these match the DTOs) -----------------------

const STATE: State = "GREEN";
const LEVEL: AlertLevel = "OK";
const CHANNEL: Channel = "FIN";
const DIRECTION: Direction = "HIGH";
const THRESHOLDS: Thresholds = { amberLevel: 1, redLevel: 2 };

const alert: AlertRecordDTO = {
  date: "2026-06-27",
  level: LEVEL,
  bandReason: "regime",
  dialBand: LEVEL,
  dialState: null,
  displayDialState: null,
  panelState: null,
  displayPanelState: null,
  fin: 0,
  rate: 0,
  geoFlags: 0,
  coincident: STATE,
  finReds: 0,
  firedAt: "2026-06-27T00:00:00Z",
  pushedAt: null,
  pushError: null,
  degraded: [],
  timings: { cold: true, anchorMs: 9100, marks: { load: 2000 } },
  nonLiveFamilies: null,
  slowScore: null,
  slowBand: null,
  slowMaxScore: null,
  bottomState: null,
  vix: null,
  vix3m: null,
  ratio: null,
  r4Phase: null,
  r4EntryFiredAt: null,
  r4ReentryRung: null,
  heldSleeve: null,
  reriskConfirmCount: 0,
  heldDays: 0,
  cashOverlay: "off",
  cashOverlaySince: null,
  cashOverlayReason: null,
  dialTargetRung: null,
  fallShape: "indeterminate",
  fallVelocity: null,
  creditDwellCloses: null,
};

const reading: ReadingDTO = {
  indicatorId: "F1",
  label: "HY OAS",
  date: "2026-06-27",
  value: 3.2,
  delta20: 0.1,
  rawState: STATE,
  state: STATE,
  ageDays: 1,
  unit: "days",
  lag: false,
  source: "roster",
};

// Typed as the STORE SeriesPoint minus `bandCuts` (its `| null` never reaches the wire —
// api/series.ts `stripStoredCuts`): fills `SeriesResponse.points` (widens to the nullable
// SeriesPointDTO) and pins the `SeriesPoint` schema itself.
const seriesPoint: Omit<SeriesPoint, "bandCuts"> = {
  date: "2026-06-27",
  value: 3.2,
  delta20: 0.1,
  rawState: STATE,
  state: STATE,
};

const status: StatusResponse = {
  verdict: alert,
  readings: [reading],
  asOf: "2026-06-27",
  deployId: "dpl_sample",
  alertLinks: true,
  lag: false,
  feedAgeDays: 0,
  // The per-feed pill DISAGREEING with the heartbeat above is the sample's point: `lag: false`
  // (one current feed) beside a non-empty stale roster is exactly the state §Ruled contract 2
  // serves both pills for. A sample mirroring `stale` would document a shape that cannot occur.
  feedsLagging: 1,
  laggingFeedIds: ["F3"],
  feedsTotal: 2,
};

const series: SeriesResponse = {
  indicatorId: "F1",
  label: "HY OAS",
  longLabel: "HY OAS",
  unit: "%",
  points: [seriesPoint],
};

const derivedView: DerivedView = {
  kind: "return",
  window: 126,
  amber: -0.15,
  red: -0.25,
  label: "6-mo return",
  unit: "%",
};

// Chart* sub-schema samples (Case 1). Each carries EVERY field its TS type declares
// (optionals included) so a field added to TS but undocumented in openapi.yaml fails
// the key check below. The band mixes source-specific optionals (metric/value/label)
// on one sample deliberately — the contract test checks keys, not per-source semantics.
const chartAxis: ChartAxis = { id: "secondary", side: "right", unit: "%", format: "derived", label: "6-mo return" };
const chartSeries: ChartSeries = { axis: "primary", fromPoint: "value", compute: "havenEnvelope", style: "envelope", gatedBy: ["belowMA200"] };
const chartBand: ChartBand = { level: "amber", axis: "primary", source: "displayBand", metric: "level", value: 0.95, label: "amber ≥0.95", fromPoint: "levelAmber" };
const chartGate: ChartGate = { key: "belowMA200", label: "MU below its 200-day MA", appliesTo: "both" };
const chartSpec: ChartSpec = { axes: [chartAxis], series: [chartSeries], bands: [chartBand], gates: [chartGate] };

// LabBand* nested-schema samples (role-split board BAND drill-down). Each carries EVERY field its
// TS type declares (optionals included) so a field added to TS but undocumented in openapi.yaml
// fails the key check below; the member mixes the r4-only value/threshold/note optionals onto one
// sample deliberately — the contract test checks keys, not per-floor semantics.
const labBandMember: LabBandMember = {
  id: "r4-rung",
  label: "dial rung",
  longLabel: "dial rung (r4 enter-input row)",
  state: "RED",
  cappedState: "RED",
  value: 8,
  threshold: 8,
  note: "rung ≥ 8 to enter",
};
const labBandFloor: LabBandFloor = { id: "r4", level: "CRITICAL", cap: "CRITICAL", members: [labBandMember] };
const labBand: LabBand = {
  level: "CRITICAL",
  dialBand: "WARNING",
  source: "r4",
  chain: { dangerScore: 0.5, regime: "Stress", band: "CRITICAL" },
  floors: [labBandFloor],
};

// EW-R1 Stage 4.1 / EW-7 samples. Both carry EVERY field their TS type declares, so a
// field added to TS but undocumented in openapi.yaml fails the key check below.
const bpsSensitivityPoint: BpsSensitivityPoint = {
  window: "trailing-5y @ 2019-12-31",
  start: "2014-12-31",
  asOf: "2019-12-31",
  n: 1305,
  amberBps: 465.64,
  redBps: 629.6,
};
const bpsSensitivity: BpsSensitivity = {
  source: "scripts/backtest/f1_cuts.json",
  series: "BAMLH0A0HYM2",
  leg: "level",
  percentiles: { amber: 0.66, red: 0.9 },
  points: [bpsSensitivityPoint],
};

const indicatorMeta: IndicatorMeta = {
  id: "F1",
  label: "HY OAS",
  series: "BAMLH0A0HYM2",
  channel: CHANNEL,
  unit: "%",
  thresholds: THRESHOLDS,
  direction: DIRECTION,
  role: "member",
  cadence: "monthly",
  velocityWindow: 30,
  obsCadence: "daily",
  derived: derivedView,
  chart: {
    axes: [{ id: "primary", side: "left", unit: "%", format: "value" }],
    series: [{ axis: "primary", fromPoint: "value", style: "primary" }],
    bands: [{ level: "amber", axis: "primary", source: "threshold", metric: "level" }],
  },
  bpsSensitivity: bpsSensitivity,
  companionAnchorDate: "2014-12-31",
};

// GET /api/config serves these src/ constants verbatim (api/config.ts), so
// the samples ARE the served payload — a renamed key in src/ or openapi.yaml
// breaks this.
const ladderConfig = {
  alertRank: ALERT_RANK,
  ladder: [...LADDER],
  legIds: LADDER.map((sleeve) => legCloseId(sleeve)),
  scoringCuts: {
    pension: { dip: PENSION_DIP, correction: PENSION_CORRECTION, bear: PENSION_BEAR, confirmCloses: CONFIRM_CLOSES },
    slow: { accelAmber: ACCEL_AMBER_PCTILE, accelRed: ACCEL_RED_PCTILE, vixLow: VIX_LOW_PCTILE, nearHigh: NEAR_HIGH_FRAC },
    vt: { amber: VT_AMBER_RATIO, red: VT_RED_RATIO },
  },
};

// GET /api/lab: an all-calm sample built from the SAME pure builders the handler
// runs (families/t1dial/danger-engine — the ladderConfig idiom), so a field added
// to LabResponse (or any builder's result type) is a compile error here until the
// YAML documents it. Live-only optionals (asOf/firedAt/downsideDetectors) and the
// scenario-only `states` are all present on the sample —
// the type allows it, and presence is what pins them to the YAML.
const usPanel = computeFamilyPanelFromStates({}, US_FAMILIES);
const globalPanel = computeFamilyPanelFromStates({}, GLOBAL_FAMILIES);
// The notify-axis twin (C1 ruling §17.7) — folded against the real DIAL_FAMILIES table, so the
// sample carries the SAME two panels api/lab.ts serves.
const dialPanel = computeFamilyPanelFromStates({}, DIAL_FAMILIES);
const t1dial = computeT1Dial(globalPanel.families);
// Stage 0.1: the shared overlay wire shape. `note` is the one optional — it is ABSENT
// (not empty) when an overlay has no rationale line, so it is listed as optional below.
const overlayView: OverlayView = {
  id: "r4",
  label: "Cash / haven circuit-breaker",
  headline: "phase: —",
  tone: "neutral",
  fields: [{ label: "phase", value: "—" }],
  note: "sample",
  group: "not-wired",
};
// The `[coverage]` payload run-cycle-dial.ts really records. NON-NULL `series`/`state`/`ageDays` on the
// `stale` mark and ALL-NULL on the `absent` one — that IS the reason split (an absent member has no
// reading this run to describe), and only the populated literal type-checks the keys against the DTO.
// GT is a `trend` coincident member and GB its roster sibling, so this is a book the engine can emit.
const coverageMark: CoverageMarkDTO = { id: "GT", reason: "lag", series: "ACWI", state: STATE, ageDays: 9 };
const coverageDegrade: CoverageDegradeDTO = {
  family: "trend",
  verdict: STATE,
  carried: false,
  members: [coverageMark, { id: "GB", reason: "absent", series: null, state: null, ageDays: null }],
};

const lab: LabResponse = {
  ...usPanel,
  t1dial,
  globalFamilies: globalPanel.families,
  dialFamilies: dialPanel.families,
  // D3/D4 served roster — built from the t1dial constants the handler serves, so a drift in the
  // wire shape is a compile error here until the YAML documents it.
  dangerRoster: { legWeightedIds: [...LEG_WEIGHTED_IDS], perLegOnlyIds: [...PER_LEG_ONLY_MEMBERS], noArmFamilies: [...NO_ARM_FAMILIES], pillarIds: [...PILLAR_MEMBER_IDS] },
  field: computeField({ globalFamilies: globalPanel.families }, t1dial.band),
  feedLag: [{ id: "F9", label: "DEEP-LAG", age: 9, p90Gap: 3, deepLagBar: 6, lagCut: 2, registered: "daily" }],
  // A4 — REQUIRED on the wire, so its presence here is what pins the key to the YAML. `false` is the
  // healthy value (a stamp was read); `true` says the census behind this payload measured nothing.
  freshnessMissing: false,
  // NON-EMPTY on purpose (the feedLag pattern above): `[]` is the healthy served value, but only a
  // populated sample type-checks the entry against the TS DTO. The ITEM shape is pinned to the YAML
  // by the `CoverageDegrade` / `CoverageMark` cases below (a `$ref` alone
  // would leave every key unpoliced — `propertiesOf` reads 8-space keys only, so an inline+nested
  // `items:` block is invisible to this harness in BOTH directions). The `reason` ENUM stays
  // unpoliced here — the harness compares KEY sets, exactly as the `tone` block below records.
  coverage: [coverageDegrade],
  overlays: { r4: overlayView },
  mode: "scenario",
  states: {},
  asOf: "2026-06-27",
  firedAt: "2026-06-27T00:00:00Z",
  pruneFailed: { firedAt: "2026-06-27T00:00:00Z", reason: "canceling statement due to statement timeout" },
  bandReason: "regime",
  // W5-a Stage 2.2 — live-only like bandReason, so presence on this sample is what pins
  // the three keys to the YAML (openapi-drift.test.ts pins existence only; W1-f showed it
  // misses a shape break entirely, so the key pin has to live here).
  cashOverlay: { level: "partial", since: "2026-06-27T00:00:00Z", reason: "target rung 3→5 (+2) within 3 closes" },
  downsideDetectors: [{ id: "SMH", state: STATE }],
  // G0 Stage 0.3 — the per-leg growth RS block. Present whenever a store was read (live always is);
  // its presence on this sample is what pins the two keys to the YAML. The `null` and `0` entries
  // exercise the `[number, "null"]` idiom — a 0 RS is legitimate and distinct from a null one.
  growthRs: [
    { sleeve: "S&P 500", rs: 0.42 },
    { sleeve: "Cash", rs: null },
    { sleeve: "Gold", rs: 0 },
  ],
  lookbacksUsed: 3,
};

// Rung 3, Stage 6.1: `FamilyMeta` (GET /families) and `Family` (a /lab panel entry)
// were BOTH absent from CASES, so their property blocks were unpinned — the plan's
// "openapi-drift.test.ts pins this" claim did not survive a grep (plan-hygiene: never
// inherit a coverage claim). Pinning them here is what makes the new optional
// `awaiting` a contract field rather than an undocumented one.
// `valuation` is the deliberate sample family: it is the only one carrying `awaiting`,
// so a sample keyed off any other family would leave the new field untested.
const familyMetaSample: FamilyMeta = (() => {
  const f = DASHBOARD_FAMILIES.find((x) => x.key === "valuation")!;
  // E6(a): `ids` is REQUIRED on FamilyMeta. `valuation` is feedless, so this sample carries the
  // empty array — the field's presence is what the contract pins here; its ORDER is pinned in
  // families.test.ts §"E6(a) impact order" against a family that actually has members.
  return { key: f.key, label: f.label, desc: f.desc, awaiting: f.awaiting, ids: [...f.ids] };
})();
const familyPanelSample = usPanel.families.find((f) => f.key === "valuation")!;
// D2 (family-colour-follows-danger): the credit-leg-red shape the existing non-band samples above
// never reach. `credit` IS band-driving, so an F10-only red (F10 is not seated on the band) folds to a
// GREEN band state but emits `cannotArm: {count:1, worst:"RED"}` — the field the tile mark reads. This
// pins the `cannotArm` block PRESENT (the valuation sample leaves it undefined). Real fold
// over the live credit roster, so the shape tracks the roster rather than a frozen literal.
const creditRoster = GLOBAL_FAMILIES.find((f) => f.key === "credit")!;
const familyPanelCannotArmSample = computeFamilyPanel(
  creditRoster.ids.map((id) => ({ id, state: id === "F10" ? ("RED" as State) : ("GREEN" as State) })),
  [creditRoster],
).families[0]!;

// LabResponse.field / field.legRows[] (named schemas `FieldResult` / `LegRow`).
// LabResponse's own case pins only its TOP-LEVEL keys (requiredOf reads the block's
// first `required: [...]`), so before these two cases the whole per-leg wire was
// unpinned — `LegRow extends LegField`, and all six LegField props (region/rgn/
// exposure/sector/sec/style, read live by public/lab.js) had drifted out of the YAML.
// Hand-written literals on purpose (NOT computeField(...).legRows[0]): only a typed
// object literal turns a field added to LegRow/LegField into a compile error here.
// Every optional (momentum/snRoc/ewRoc — the ?hist / live-only speed seams) is present
// on the sample; presence is what pins them to the YAML.
// OQ-5 Stage 5.4 — the per-cell observation census on the wire. Typed against the DTOs (which
// re-export the engine types), so a field added to `SignalCell`/`CellObserved` is a compile error
// here until openapi.yaml documents it. The counts are a COHERENT book, not three arbitrary
// numbers: this is a measured cell, so `fresh + stale + absent` must equal `N` (the invariant
// `api/lab.test.ts` re-checks at runtime over the served response).
const cellObserved: CellObservedDTO = { fresh: 1, lag: 1, absent: 1, deepLag: 1 };
// B2 — the hold-window provenance rides the same DTO; a non-null sample is what pins `HeldMark`'s
// key set against the YAML (a `null` here would document nothing).
const heldMark: HeldMarkDTO = { member: "R4", closes: 7, ageCloses: 2 };
const signalCell: SignalCellDTO = {
  family: "cr",
  cellState: "calm",
  M: 0,
  N: cellObserved.fresh + cellObserved.lag + cellObserved.absent,
  wsev: 0,
  observed: cellObserved,
  held: heldMark,
};

const legRow: LegRowDTO = {
  sleeve: "S&P 500",
  region: "US",
  rgn: "US",
  exposure: "Broad",
  sector: "Broad-market",
  sec: "Broad",
  style: "Blend",
  risk: 5,
  // OQ-5 Stage 5.4: `cells` is now a documented `SignalCell` array (it was a bare `type: object`),
  // and both it and its `observed` census are pinned by their own CASES rows below.
  cells: [signalCell],
  danger: 0.1,
  subDangers: {
    earlyWarn: { kind: "scored", value: 0.1 },
    stressNow: { kind: "uncomparable", reason: "not-live" },
    trend: 0.05,
    gp: null,
  },
  regime: "calm",
  momentum: 0.02,
  snRoc: 0.01,
  ewRoc: -0.03,
  concentrated: false,
  growth: 0.5,
  volAdjMom: 0.3,
  trend: { value: 0.42, counting: true },
  familiesLit: { earlyWarn: { lit: 1, of: 2 }, stressNow: { lit: 0, of: 2 } },
  coverage: {
    "EARLY-WARN": { live: 1, capable: 2 },
    "STRESS-NOW": { live: 1, capable: 2 },
    CONFIRMING: { live: 1, capable: 1 },
    EXOGENOUS: { live: 0, capable: 1 },
  },
  // W4 Stage 4.1 — the `warmup` arm is what `toServedField` emits for a scored EW pillar today
  // (this sample's earlyWarn IS scored), so the sample rides the same arm production does.
  ewPct: { kind: "warmup" },
};

const fieldResult: FieldResultDTO = {
  legRows: [legRow],
  band: { lo: 0, hi: 0.25, label: "OK" },
  held: legRow,
  exogenous: { active: false, floor: 0 },
  // The map the cells were built from (`FieldResult.memberState`) — the HELD/GATED vintage, not the
  // served family panel. One entry is enough for the schema pin; the absent-means-ABSENT contract is
  // exactly why the sample does not enumerate every member.
  memberState: { F1: { sev: "elev", obs: "fresh", held: true } },
};

// GET /api/lab ?replay= (mode 2b): the wire shape api/lab.ts wraps around
// src/replay.ts's ReplayResult — the `mode`/`start`/`end` envelope + points/coverage/
// notes. Typed against the DTOs so a field added to ReplayPoint/ReplayCoverage (or the
// response envelope) is a compile error here until openapi.yaml documents it.
const replayPoint: ReplayPointDTO = {
  date: "2026-06-27",
  targetRung: 1,
  band: LEVEL,
  regime: "Calm",
  r4Phase: "equity",
  cash: false,
  reentryRung: null,
};
const replayCoverage: ReplayCoverageDTO = { id: "F1", firstDate: "2011-01-03" };
const replay: ReplayResponseDTO = {
  mode: "replay",
  start: "2025-06-27",
  end: "2026-06-27",
  points: [replayPoint],
  coverage: [replayCoverage],
  notes: ["R4 state warmed from equity 60 trading days before range start."],
};

// GET /api/replay (episode body + `?companion=`): the REDACTED shapes, so the optional `redacted`
// key is pinned both ways.
const exposureReplayPoint: ExposureReplayPointDTO = {
  date: "2008-09-15",
  price: null,
  armed: true,
  fired: false,
  posture: "Reduced",
  degraded: false,
};
const exposureReplayEpisode: ExposureReplayEpisodeDTO = {
  id: "2008",
  label: "2008 GFC",
  start: "2006-10-31",
  end: "2008-11-20",
  candidate: false,
  rationale: "r",
  points: [exposureReplayPoint],
  defensive: [{ date: "2008-09-15", price: null }],
  notes: [],
};
const exposureReplay: ExposureReplayResponse = { asOf: "2026-06-27", episodes: [exposureReplayEpisode], redacted: true };
const replayCompanion: ReplayCompanionResponse = { indicatorId: "VIXCLS", label: "VIX", unit: "", points: [], redacted: true };

// GET /api/danger-model serves these danger-ladder.ts / families.ts exports verbatim
// (api/danger-model.ts — the ladderConfig idiom), so the sample IS the served payload;
// guards superGroups/superGroupOf (and every other model key) against openapi ↔ TS drift.
const dangerModelSample: DangerModel = {
  signalOf: SIGNAL_OF,
  familyOfSignal: FAMILY_OF_SIGNAL,
  superGroups: [...SUPER_GROUPS],
  superGroupOf: SUPER_GROUP_OF,
  memberRelevance: Object.fromEntries(
    Object.entries(MEMBER_RELEVANCE).map(([id, set]) => [id, [...set]]),
  ),
  memberWeight: MEMBER_WEIGHT,
  memberLabel: MEMBER_LABEL,
  clusters: CLUSTERS.map((c) => [...c]),
  concThreshold: CONC_THRESHOLD,
  concWeight: CONC_WEIGHT,
  deriskDeadband: DERISK_DEADBAND,
  reriskDeadband: RERISK_DEADBAND,
  reriskConfirm: RERISK_CONFIRM,
  reriskDwellDays: RERISK_DWELL_DAYS,
  legRagCuts: { amber: DANGER_CUTS.amber, red: DANGER_CUTS.red },
  pillarIds: [...PILLAR_MEMBER_IDS],
};

// GET /api/exposure (slice E1): the two-key dial. All top-level fields required
// (posture is nullable-but-present); the nested arm/fire shapes aren't asserted by
// requiredOf (it pins only the block's first `required: [...]` = the top-level keys).
// Inputs for the sample below, kept as named constants so the derived booleans read as
// derivations rather than as a second set of hand-typed answers.
const EXPOSURE_ROC = ARM_ROC_APPROACH_BP; // exactly at the approach cut ⇒ approaching
// FIRE consumes GT's resolved band (CORE-B4), so the pre-alert edge is that band + the margin.
const EXPOSURE_FIRE_CUT = resolvedDerivedBands(GT).amber!;
const EXPOSURE_MA_SPREAD = EXPOSURE_FIRE_CUT + FIRE_MA_APPROACH_SPREAD + 0.01; // clear of both ⇒ NOT approaching

const exposure: ExposureResponse = {
  posture: "Core",
  // Same derive-don't-type rule: equityPct is an OUTPUT of posture (`exposure.ts` postureOf).
  equityPct: EQUITY_PCT.Core,
  // `approaching` is an OUTPUT of the same cut this fixture sets
  // (`!armed && roc >= ARM_ROC_APPROACH_BP`), so derive it instead of hand-typing. The old
  // literal paired `roc: 0.02` with `approaching: true` — a book the engine can never emit.
  arm: { armed: false, approaching: EXPOSURE_ROC >= ARM_ROC_APPROACH_BP, degraded: false, level: 3.2, percentile: 0.34, roc: EXPOSURE_ROC, asOf: "2026-06-27" },
  // Same rule, other cut: `!fired && maSpread <= GT's resolved amber + FIRE_MA_APPROACH_SPREAD`.
  fire: {
    fired: EXPOSURE_MA_SPREAD < EXPOSURE_FIRE_CUT,
    approaching: EXPOSURE_MA_SPREAD <= EXPOSURE_FIRE_CUT + FIRE_MA_APPROACH_SPREAD,
    degraded: false,
    maSpread: EXPOSURE_MA_SPREAD,
    asOf: "2026-06-27",
  },
  summary: `credit calm (34th pct, +${(EXPOSURE_ROC * 100).toFixed(0)}bp/30d); trend clear of GT's cut -> Core (70% equity)`,
  asOf: "2026-06-27",
  // R1: the served cuts. Taken from the engine's own bundle — a hand-typed copy here would be
  // the third source the seam ruling exists to prevent.
  thresholds: EXPOSURE_THRESHOLDS,
};

// schema name in openapi.yaml → typed sample + fields that are optional there.
const CASES: Array<{ schema: string; sample: object; optional?: string[]; variant?: string }> = [
  { schema: "AlertRecord", sample: alert, optional: ["panelState", "displayPanelState", "timings"] },
  { schema: "Reading", sample: reading },
  { schema: "SeriesPoint", sample: seriesPoint },
  // The three per-feed pill fields are OPTIONAL together (a degraded freshness read omits them
  // rather than serving `feedsLagging: 0`); the sample carries them, so both directions stay pinned.
  { schema: "StatusResponse", sample: status, optional: ["feedsLagging", "laggingFeedIds", "feedsTotal"] },
  { schema: "SeriesResponse", sample: series, optional: ["longLabel", "unit"] },
  {
    schema: "IndicatorMeta",
    sample: indicatorMeta,
    optional: ["unit", "direction", "cadence", "velocityWindow", "velocityMode", "obsCadence", "derived", "chart", "bpsSensitivity", "companionAnchorDate"],
  },
  { schema: "BpsSensitivity", sample: bpsSensitivity },
  { schema: "BpsSensitivityPoint", sample: bpsSensitivityPoint },
  { schema: "DerivedView", sample: derivedView, optional: ["window"] },
  { schema: "LadderConfig", sample: ladderConfig },
  { schema: "ChartAxis", sample: chartAxis, optional: ["label", "domain"] },
  { schema: "ChartSeries", sample: chartSeries, optional: ["fromPoint", "compute", "gatedBy"] },
  { schema: "ChartBand", sample: chartBand, optional: ["metric", "value", "label", "fromPoint"] },
  { schema: "ChartGate", sample: chartGate },
  { schema: "ChartSpec", sample: chartSpec, optional: ["gates"] },
  { schema: "OverlayView", sample: overlayView, optional: ["note", "group"] },
  { schema: "LabResponse", sample: lab, optional: ["asOf", "firedAt", "pruneFailed", "bandReason", "band", "cashOverlay", "downsideDetectors", "states", "growthRs", "lookbacksUsed"] },
  { schema: "LabBand", sample: labBand },
  { schema: "LabBandFloor", sample: labBandFloor },
  { schema: "LabBandMember", sample: labBandMember, optional: ["longLabel", "value", "threshold", "note"] },
  { schema: "CoverageDegrade", sample: coverageDegrade },
  { schema: "CoverageMark", sample: coverageMark },
  { schema: "FieldResult", sample: fieldResult },
  { schema: "LegRow", sample: legRow, optional: ["momentum", "snRoc", "ewRoc"] },
  { schema: "SignalCell", sample: signalCell },
  { schema: "CellObserved", sample: cellObserved },
  // `ageCloses` is OPTIONAL in the YAML (a pre-Stage-2 member map carries none), so it needs BOTH the
  // sample and this entry: a property in neither is unchecked in both directions, and dropping or
  // renaming it in openapi.yaml would leave the suite green.
  { schema: "HeldMark", sample: heldMark, optional: ["ageCloses"] },
  { schema: "ReplayPoint", sample: replayPoint },
  { schema: "ReplayCoverage", sample: replayCoverage },
  { schema: "ReplayResponse", sample: replay },
  { schema: "ExposureReplayPoint", sample: exposureReplayPoint },
  { schema: "ExposureReplayEpisode", sample: exposureReplayEpisode, optional: ["defensive"] },
  { schema: "ExposureReplayResponse", sample: exposureReplay, optional: ["redacted"] },
  { schema: "ReplayCompanionSeries", sample: replayCompanion, optional: ["redacted"] },
  // NB: requiredOf pins only the schema block's FIRST `required: [...]` — DangerModel's
  // top-level keys. Nested property shapes are not asserted here.
  { schema: "DangerModel", sample: dangerModelSample },
  { schema: "ExposureResponse", sample: exposure },
  { schema: "FamilyMeta", sample: familyMetaSample, optional: ["desc", "awaiting"] },
  { schema: "Family", sample: familyPanelSample, optional: ["absentIds", "coverageDegraded", "carriedOnly", "verdictHoldIds", "band", "cannotArm", "bandLagIds", "note", "desc", "awaiting"] },
  { schema: "Family", sample: familyPanelCannotArmSample, optional: ["absentIds", "coverageDegraded", "carriedOnly", "verdictHoldIds", "band", "cannotArm", "bandLagIds", "note", "desc", "awaiting"], variant: "cannotArm present" },
];

// R1 (2026-07-18): `tone` is an ENUM the CASES table above cannot police — that harness
// compares KEY sets, so a value added to the TS union (or to the YAML enum) drifts green. Three
// directions closed: TS union → list (compile-time, below), list → YAML, and list → the FE
// renderer's own allowlist (an unknown tone there degrades to "neutral", i.e. a server tone the
// FE never learned about paints as "off" — silent, and exactly what R1 fixed). The last two are
// the `OverlayView.tone` row of the enum-sync table below.
const TONE_VALUES = ["neutral", "caution", "alert", "reentry"] as const;
// Compile-time: fails `tsc` if OverlayView["tone"] gains a value missing from TONE_VALUES.
type UncoveredTone = Exclude<OverlayView["tone"], (typeof TONE_VALUES)[number]>;
const _toneExhaustive: UncoveredTone extends never ? true : never = true;
void _toneExhaustive;

// W5-d Stage 4.1: the `fallShape` overlay's three-state class. Like `tone` above, the CASES
// harness cannot police it — `overlays` is `additionalProperties: OverlayView`, so the class only
// ever reaches the contract as PROSE in the `overlays` description, and openapi-drift.test.ts
// pins the ROUTE TABLE (plus chart-spec `fromPoint` ⇄ SeriesPoint properties) — never enum
// values, never descriptions (2026-08-01 correction; "existence/shape" overclaimed). Two directions closed: TS union → list
// (compile-time) and list → the YAML prose.
const FALL_SHAPE_VALUES = ["v-shaped", "bear", "indeterminate"] as const;
// Compile-time: fails `tsc` if FallShape gains a state missing from FALL_SHAPE_VALUES.
type UncoveredFallShape = Exclude<FallShape, (typeof FALL_SHAPE_VALUES)[number]>;
const _fallShapeExhaustive: UncoveredFallShape extends never ? true : never = true;
void _fallShapeExhaustive;

describe("LabResponse.overlays.fallShape documents every class the server can emit", () => {
  it("names all three FallShape states in the overlays description", () => {
    const block = schemaBlock("LabResponse");
    const at = block.indexOf("        overlays:");
    expect(at, "LabResponse.overlays is a top-level property").toBeGreaterThanOrEqual(0);
    const desc = block.slice(at, block.indexOf("        mode:", at));
    // Vacuity guard: the slice must actually be the overlays block, not an empty window.
    expect(desc).toContain("fallShape");
    for (const s of FALL_SHAPE_VALUES) {
      expect(desc, `overlays description names FallShape "${s}"`).toContain(`\`${s}\``);
    }
  });
});

// NF-1 Stage 5.2 follow-up: `FallShapeOverlayView.confidence` is the SECOND enum the CASES harness
// cannot police (it lives inside an `allOf`, and the harness compares the first `required:` block's
// key set). Same three directions the `tone` block above closes, one rung stronger — the list is not
// hand-typed here but IMPORTED, so the "two sources must agree" trap (a third copy in the test file)
// cannot arise: TS union → list (compile-time), list → the YAML enum (the enum-sync table's
// `FallShapeOverlayView.confidence` row), list → the YAML prose that a human reads (below).
// Vacuity is guarded on the parse of each side.
const CONFIDENCE_VALUES = FALL_SHAPE_CONFIDENCE_VALUES;
// Compile-time: fails `tsc` if FallShapeConfidence gains a key the exported list does not carry.
type UncoveredConfidence = Exclude<FallShapeConfidence, (typeof CONFIDENCE_VALUES)[number]>;
const _confidenceExhaustive: UncoveredConfidence extends never ? true : never = true;
void _confidenceExhaustive;

describe("FallShapeOverlayView.confidence documents every key the server can emit", () => {
  it("the schema's own prose names every key the server can emit", () => {
    // The FE and every other consumer branch on the KEY, but a HUMAN reads the description — a key
    // present in the enum and absent from the prose ships an undocumented wire value.
    const block = schemaBlock("FallShapeOverlayView");
    const desc = block.slice(0, block.indexOf("      allOf:"));
    expect(desc, "the description slice is the real block, not an empty window").toContain("confidence");
    for (const k of CONFIDENCE_VALUES) {
      expect(desc, `FallShapeOverlayView description names confidence "${k}"`).toContain(`\`${k}\``);
    }
  });
});

describe("openapi ↔ TS DTO contract", () => {
  for (const { schema, sample, optional = [], variant } of CASES) {
    it(`${schema}${variant ? ` (${variant})` : ""}: openapi required fields ⟷ TS sample keys`, () => {
      const required = requiredOf(schema);
      const keys = Object.keys(sample);
      expect(required.length).toBeGreaterThan(0); // sanity: we actually parsed a block
      // Every field the YAML marks required must exist on the TS shape.
      for (const f of required) expect(keys).toContain(f);
      // Every TS field must be declared in the YAML (required or a known optional)
      // — catches a field added to TS but never documented in the contract.
      for (const k of keys) expect([...required, ...optional]).toContain(k);
      // Close the other direction: each self-declared `optional` must be a REAL
      // property in the YAML block — else a typo'd/renamed optional "documents" a
      // field that isn't actually in the contract, and the drift ships green.
      const props = propertiesOf(schema);
      for (const o of optional) expect(props, `${schema}.${o} in openapi properties`).toContain(o);
    });
  }

  // D2: the credit-leg-red sample is only a contract witness if it actually carries the shape. Pins
  // the VALUE the KEY-set harness above cannot: a band-driving family with one unseated red folds
  // GREEN yet reports `cannotArm: {count:1, worst:"RED"}`. RED-DEMO: swap F10→a band-driving id
  // (EBP) and the band seats it ⇒ cannotArm undefined ⇒ this reds.
  it("D2 cannotArm rides a band-driving family whose only red cannot arm", () => {
    expect(familyPanelCannotArmSample.state).toBe("GREEN");
    expect(familyPanelCannotArmSample.firing).toBe(false);
    expect(familyPanelCannotArmSample.cannotArm).toEqual({ count: 1, worst: "RED", worstCount: 1 });
  });
});

/**
 * Enum sync: every "TS enum/union ⟷ hand-typed copy" check, one table. The CASES
 * harness above compares KEY sets and is blind to enum CONTENTS, so each value list below needs its
 * own pin. A row names the TS source (`ts` — an imported constant, or, for a type-only union that
 * nothing can import, the parsed `src/api/types.ts` text) and every hand-typed copy (`sites` — an
 * openapi.yaml enum, or a FE allowlist). A set-wise compare reds when EITHER side gains a member the
 * other lacks; `ordered` rows compare positionally; `nullable` appends the trailing `null` member.
 *
 * Why each row exists:
 * - `legAttribution[].id` — the ONLY id list the wire promises, while the population reaching it is
 *   `dualAxisFiringIds` (src/lab-served-field.ts) gating on `DUAL_AXIS_ID_SET`. It sat at
 *   a stale id list while BAA10Y, F3 and a EUR spread id had joined the set: the served response carried ids
 *   the contract forbade.
 * - leg vocabulary — promised at THREE sites (`SeriesPointDTO.leg`, `SeriesResponse.scorerLegs.items`,
 *   `legAttribution[].leg`); `vel-cusum` (2026-08-08) had to be added to all three. Sites are found by
 *   "an inline enum containing `vel-z`", so `minSites` is what makes it non-vacuous; one site lists
 *   `evt` before `vel-op`, hence set-wise.
 * - `ChartSeries.compute` / `FeedLagRow.source` — TS *types*, so both source texts are parsed.
 *   `lowRise` (and `probit` before it) shipped to the TS side while the enum lagged.
 * - `OverlayView.tone` — an unknown tone in the FE allowlist degrades to "neutral" (R1); the
 *   allowlist is read out of `public/overlay-strip.js`, plain `.js` tsc never sees.
 * - `FallShapeOverlayView.confidence` — inside an `allOf`, out of the CASES harness's reach.
 * - posture / equityPct — measured 2026-07-20: dropping `Full` from BOTH posture enums, and
 *   typo'ing an equityPct weight to 71, each left every CASES row green; the weights were a second
 *   hand-typed copy of the four [USER DECIDED] `EQUITY_PCT` values.
 *
 * Vacuity: every row's TS side and every site must parse NON-EMPTY (a rotted regex reds, never
 * passes); `witness` — a stable member — must appear on both sides of a text-parsed row so a parse
 * that latched onto the WRONG enum reds too. One collecting assert: a red names every drifted row.
 */
describe("openapi ↔ TS enum sync", () => {
  type EnumSyncRow = {
    name: string;
    ts: readonly string[] | undefined;
    sites: { at: string; values: string[] | undefined }[];
    minSites?: number;
    ordered?: boolean;
    nullable?: boolean;
    witness?: string;
  };
  const listOf = (raw: string | undefined): string[] | undefined =>
    raw
      ?.split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  const TYPES_TS = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
  const STORE_TS = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
  // The quoted members of the first TS string-literal union `re` captures in src/api/types.ts.
  const tsUnion = (re: RegExp): string[] | undefined => {
    const raw = TYPES_TS.match(re)?.[1];
    return raw === undefined ? undefined : [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  };
  // The first inline `enum: [...]` at or after a schema's top-level (8-space) `prop:` key.
  const enumAfter = (schema: string, prop: string): string[] | undefined => {
    const block = schemaBlock(schema);
    const at = block.indexOf(`        ${prop}:`);
    return at < 0 ? undefined : listOf(block.slice(at).match(/enum:\s*\[([^\]]*)\]/)?.[1]);
  };
  // `legAttribution:` is an 8-space property nested inside a response schema, not a schema of its own.
  const legAttributionIdEnum = (): string[] | undefined => {
    const lines = OPENAPI.split("\n");
    const start = lines.findIndex((l) => /^ {8}legAttribution:/.test(l));
    if (start < 0) return undefined;
    const after = lines.slice(start + 1);
    const end = after.findIndex((l) => /^ {8}\S/.test(l));
    const block = (end === -1 ? after : after.slice(0, end)).join("\n");
    return listOf(block.match(/^ +id: \{ type: string, enum: \[([^\]]+)] }/m)?.[1]);
  };
  const postures = Object.keys(EQUITY_PCT) as Posture[];

  const ROWS: EnumSyncRow[] = [
    {
      name: "legAttribution[].id ⟷ DUAL_AXIS_IDS",
      ts: DUAL_AXIS_IDS,
      sites: [{ at: "openapi legAttribution[].id", values: legAttributionIdEnum() }],
    },
    {
      name: "leg enums ⟷ LEG_ORDER",
      ts: LEG_ORDER,
      sites: [...OPENAPI.matchAll(/enum: \[([^\]]*\bvel-z\b[^\]]*)\]/g)].map((m) => ({
        at: `openapi ${m[0]}`,
        values: listOf(m[1]),
      })),
      minSites: 3,
    },
    {
      name: "ChartSeries.compute ⟷ TS union",
      ts: tsUnion(/compute\?:\s*("[^;]+");/),
      sites: [
        {
          at: "openapi ChartSeries.compute",
          values: listOf(OPENAPI.match(/compute: \{ type: string, enum: \[([^\]]+)]/)?.[1]),
        },
      ],
      witness: "havenEnvelope",
    },
    {
      name: "FeedLagRow.source ⟷ TS union",
      ts: tsUnion(/source:\s*("p90"(?:\s*\|\s*"[^"]+")+);/),
      sites: [
        {
          at: "openapi FeedLagRow.source",
          values: listOf(OPENAPI.match(/source: \{ type: string, enum: \[([^\]]*\bp90\b[^\]]*)]/)?.[1]),
        },
      ],
      witness: "run-row",
    },
    {
      name: "OverlayView.tone ⟷ TONE_VALUES",
      ts: TONE_VALUES,
      sites: [
        {
          at: "openapi OverlayView.tone",
          values: listOf(schemaBlock("OverlayView").match(/tone:\s*\n\s*type: string\s*\n\s*enum:\s*\[([^\]]*)\]/)?.[1]),
        },
        {
          at: "public/overlay-strip.js TONES",
          values: listOf(
            readFileSync(new URL("../../public/overlay-strip.js", import.meta.url), "utf8").match(
              /const TONES = new Set\(\[([^\]]*)\]\)/,
            )?.[1],
          ),
        },
      ],
    },
    {
      name: "FallShapeOverlayView.confidence ⟷ FALL_SHAPE_CONFIDENCE_VALUES",
      ts: CONFIDENCE_VALUES,
      sites: [
        {
          at: "openapi FallShapeOverlayView.confidence",
          values: listOf(
            schemaBlock("FallShapeOverlayView").match(/confidence:\s*\n\s*type: string\s*\n\s*enum:\s*\[([^\]]*)\]/)?.[1],
          ),
        },
      ],
    },
    {
      name: "posture ⟷ EQUITY_PCT keys",
      ts: postures,
      sites: ["ExposureResponse", "ExposureReplayPoint"].map((s) => ({
        at: `openapi ${s}.posture`,
        values: enumAfter(s, "posture"),
      })),
      ordered: true,
      nullable: true,
    },
    {
      name: "AlertRecord.degraded[].effect ⟷ DegradeEffect",
      ts: listOf(STORE_TS.match(/export type DegradeEffect = ([^;]+);/)?.[1]?.replaceAll("|", ",")),
      sites: [{ at: "openapi AlertRecord.degraded[].effect", values: listOf(schemaBlock("AlertRecord").match(/effect: \{ type: string, enum: \[([^\]]+)]/)?.[1]) }],
    },
    {
      name: "equityPct ⟷ EQUITY_PCT values",
      ts: postures.map((p) => String(EQUITY_PCT[p])),
      sites: [{ at: "openapi ExposureResponse.equityPct", values: enumAfter("ExposureResponse", "equityPct") }],
      ordered: true,
      nullable: true,
    },
  ];

  it("every hand-typed enum copy equals its TS source", () => {
    const drift: string[] = [];
    for (const { name, ts, sites, minSites = 1, ordered, nullable, witness } of ROWS) {
      if (!ts?.length) {
        drift.push(`${name}: TS side parsed empty (shape changed?)`);
        continue;
      }
      if (sites.length < minSites) drift.push(`${name}: ${sites.length} site(s) found, want ≥ ${minSites} (regex rot?)`);
      if (witness && !ts.includes(witness)) drift.push(`${name}: TS side lacks witness "${witness}" (wrong union parsed?)`);
      const want = [...ts, ...(nullable ? ["null"] : [])];
      const norm = (v: readonly string[]) => (ordered ? [...v] : [...v].sort()).join(", ");
      for (const { at, values } of sites) {
        if (!values?.length) drift.push(`${name}: ${at} parsed empty (shape changed?)`);
        else if (witness && !values.includes(witness)) drift.push(`${name}: ${at} lacks witness "${witness}"`);
        else if (norm(values) !== norm(want)) drift.push(`${name}: ${at} = [${norm(values)}], want [${norm(want)}]`);
      }
    }
    expect(drift).toEqual([]);
  });
});
