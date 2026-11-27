/** `alert_log.run_inputs`: every `assembleRun` input NOT
 *  re-readable from stored readings / alert_log rows nor recomputed by `assembleDial` — the replay half of a re-derive. Pure. */

import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_COMPONENTS } from "./registry-composite.js";
import type { Reading, State } from "./domain-types.js";
import type { AlertLevel } from "./ladder.js";
import type { CashPriorRow } from "./cash-overlay.js";
import type { Posture } from "./exposure.js";
import type { FallShapeVerdict } from "./v-bear.js";
import type { DegradeEvent, StoredReading } from "./store.js";
import type { ScoredTrack } from "./tracks.js";
import type { assembleRun } from "./run-core.js";

export type AssembleRunOpts = Parameters<typeof assembleRun>[0];

/** The opts a replay gets back; the caller supplies the rest (re-read rows, `now` = firedAt, `assembleDial`'s products). */
export type RunInputsReplay = Omit<
  AssembleRunOpts,
  "readingsForStore" | "last" | "prevDay" | "lastPush" | "now" | "dial" | "globalFamilies" | "cissHistory" | "panelState" | "displayDialState" | "displayPanelState"
>;

type Stamp = Pick<Reading, "ageDays" | "lag" | "unit">;
/** An estimate head the run's dials folded (`withEstimateHeads`) — kept here since the cleaners delete its `readings` row. */
type HeadRow = Pick<StoredReading, "indicatorId" | "date" | "value" | "delta20" | "rawState" | "state" | "decision" | "bandCuts">;
interface GlobalRow {
  id: string;
  date: string;
  level: number;
  delta20: number;
  rawState: State;
  state: State;
  stamp?: Stamp;
}

export interface RunInputs {
  v: 1;
  /** fired_at of the run's `last` / effective `prevDay` / `lastPush` rows (null = none) — re-read from alert_log. */
  refs: { last: string | null; prevDay: string | null; lastPush: string | null };
  geoFlags: number;
  crisisStage: number;
  /** Track notify payloads/rows are not replayed: a superseding row never re-pushes nor re-writes a track. */
  scored: Pick<ScoredTrack, "baselineField" | "alertFields">[];
  lastBands: (string | null)[];
  rsBySleeve?: Record<string, number | null>;
  momBySleeve?: Record<string, number | null>;
  recentDialBands?: AlertLevel[];
  recentAlerts?: CashPriorRow[];
  exposurePosture: Posture | null;
  fallShape: FallShapeVerdict | null;
  degradeEvents?: DegradeEvent[];
  spDistToHigh: number | null;
  nearHighTol: number | null;
  oilEst?: AssembleRunOpts["oilEst"];
  globalReadings?: GlobalRow[];
  /** The estimate heads both dials folded; absent on a row written before they were stored. */
  heads?: HeadRow[];
  /** `readings`' freshness stamps by id — resolved against run-time feed calendars, so not recomputable later. */
  stamps: Record<string, Stamp>;
}

const stampOf = (r: Reading): Stamp => ({ ageDays: r.ageDays, lag: r.lag, unit: r.unit });
const hasStamp = (r: Reading): boolean => r.ageDays !== undefined || r.lag !== undefined || r.unit !== undefined;
const mapOrUndef = (m: Map<string, number | null> | undefined) => (m === undefined ? undefined : Object.fromEntries(m));

export function toRunInputs(opts: AssembleRunOpts, heads: readonly StoredReading[] = []): RunInputs {
  const prevDay = opts.prevDay === undefined ? opts.last : opts.prevDay;
  return {
    v: 1,
    refs: { last: opts.last?.firedAt ?? null, prevDay: prevDay?.firedAt ?? null, lastPush: opts.lastPush?.firedAt ?? null },
    geoFlags: opts.geoFlags ?? 0,
    crisisStage: opts.crisisStage ?? 0,
    scored: (opts.scored ?? []).map((s) => ({ baselineField: s.baselineField, alertFields: s.alertFields })),
    lastBands: opts.lastBands ?? [],
    rsBySleeve: mapOrUndef(opts.rsBySleeve),
    momBySleeve: mapOrUndef(opts.momBySleeve),
    recentDialBands: opts.recentDialBands,
    recentAlerts: opts.recentAlerts,
    exposurePosture: opts.exposurePosture ?? null,
    fallShape: opts.fallShape ?? null,
    degradeEvents: opts.degradeEvents,
    spDistToHigh: opts.spDistToHigh ?? null,
    nearHighTol: opts.nearHighTol ?? null,
    oilEst: opts.oilEst,
    globalReadings: opts.globalReadings?.map((r) => ({
      id: r.indicator.id, date: r.date, level: r.level, delta20: r.delta20, rawState: r.rawState, state: r.state,
      ...(hasStamp(r) ? { stamp: stampOf(r) } : {}),
    })),
    heads: heads.map((h) => ({
      indicatorId: h.indicatorId, date: h.date, value: h.value, delta20: h.delta20, rawState: h.rawState, state: h.state,
      decision: h.decision ?? null, bandCuts: h.bandCuts ?? null,
    })),
    stamps: Object.fromEntries(opts.readings.filter(hasStamp).map((r) => [r.indicator.id, stampOf(r)])),
  };
}

// `globalReadings` also carry composite legs (`CMP_*`) and chart-only ids (FDX…), neither in `ALL_INDICATORS`.
const INDICATOR_BY_ID = new Map(
  [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS, ...Object.values(COMPOSITE_COMPONENTS).flat().map((c) => c.indicator)].map((i) => [i.id, i]),
);
const indicatorOf = (id: string) => {
  const ind = INDICATOR_BY_ID.get(id);
  if (ind === undefined) throw new Error(`fromRunInputs: unknown indicator id ${JSON.stringify(id)} in run_inputs.globalReadings`);
  return ind;
};
const restamp = (r: Reading, s: Stamp | undefined): Reading => (s === undefined ? r : { ...r, ...s });
const toMap = (o: Record<string, number | null> | undefined) => (o === undefined ? undefined : new Map(Object.entries(o)));

/** `readings` = the run's notify readings rebuilt from stored rows; their freshness stamps come back from `ri.stamps`. */
export function fromRunInputs(ri: RunInputs, readings: Reading[]): RunInputsReplay {
  if (ri.v !== 1) throw new Error(`fromRunInputs: unsupported run_inputs version ${JSON.stringify((ri as { v?: unknown }).v)}`);
  // Every key listed, so a new `assembleRun` input fails tsc here until it is stored or added to the Omit above.
  const out: { [K in keyof Required<RunInputsReplay>]: RunInputsReplay[K] } = {
    readings: readings.map((r) => restamp(r, ri.stamps[r.indicator.id])),
    geoFlags: ri.geoFlags,
    crisisStage: ri.crisisStage,
    scored: ri.scored.map((s) => ({
      ...s, rows: [], storedSeries: () => new Map(), notification: () => ({ push: false, message: null }), consoleLine: "",
    })),
    lastBands: ri.lastBands,
    rsBySleeve: toMap(ri.rsBySleeve),
    momBySleeve: toMap(ri.momBySleeve),
    recentDialBands: ri.recentDialBands,
    recentAlerts: ri.recentAlerts,
    exposurePosture: ri.exposurePosture,
    fallShape: ri.fallShape,
    degradeEvents: ri.degradeEvents,
    spDistToHigh: ri.spDistToHigh,
    nearHighTol: ri.nearHighTol,
    oilEst: ri.oilEst,
    globalReadings: ri.globalReadings?.map(({ id, stamp, ...rest }) => restamp({ ...rest, indicator: indicatorOf(id), decision: null }, stamp)),
  };
  return out;
}
