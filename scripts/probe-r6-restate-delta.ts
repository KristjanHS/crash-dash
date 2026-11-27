/**
 * R6 restate delta — how far the served state ribbon moved when a level leg was deleted from R6.
 * R6 rides `COMPOSITE_RESTATE_OF`, so no stored row is ever rewritten: the change is live on READ,
 * which is exactly why a before/after has to be recomputed rather than read out of the DB.
 *
 * RETARGETED 2026-09-02. It first measured the L1→N1 swap;
 * it now measures the arc's ending — N1's DELETION, leaving R6 on velocity ∨
 * absolute alone. BEFORE = N1 rolling-percentile-of-level ∨ vel ∨ abs, AFTER = vel ∨ abs (the live
 * scorer). The L1 arm is gone with the question it answered; the file name and `npm run
 * probe:r6-restate-delta` are unchanged because the measurement's SUBJECT (R6's read-path restate)
 * did not move.
 *
 * Reads prod's served `/api/series?id=R6` (read-only, `research-probes.md` §The instrument is a claim too) for the stored `value`
 * column.
 *
 * ⚠ The fold below is a re-expression of `moveLegSeries`, so it is PINNED: the AFTER ribbon must
 * reproduce `moveReadingSeriesFromValues` day-for-day or the probe exits 1 and reports nothing —
 * a probe that has drifted from the scorer measures its own reimplementation, not the change.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { combineLevelVelocity, fixedLevelState } from "../src/scorers-core.js";
import {
  highBandState,
  levelBandCuts,
  levelBandHead,
  levelBandValues,
  moveReadingSeriesFromValues,
  oatVelocityZ,
  percentileLevelState,
} from "../src/scorers-composite.js";
import { R6_DESCRIPTOR } from "../src/family-descriptor-rows.js";
import type { Indicator, State } from "../src/domain-types.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

/**
 * The RETIRED N1 band, inlined. It is a HISTORICAL shape, not a live cut: R6's `levelBand` was
 * deleted from `family-descriptor-rows.ts` on 2026-09-02 and nothing in `src/` may hold it again. This
 * probe is the one place it survives, because reconstructing the BEFORE ribbon is the probe's whole
 * job — so this literal is deliberately NOT a restatement of a live constant
 * (`indicator-loop.md` §A retune is a ONE-place edit — binds live cuts; a retired one has no touch point left to be single).
 * The same slot held `RETIRED_L1_BAND` until this file was retargeted.
 */
const RETIRED_N1_BAND = {
  kind: "rolling-percentile",
  window: 252,
  minObs: 252,
  amberP: 0.75,
  redP: 0.9,
} as const;

/** The prod read alias, resolved at use (`prodBaseUrl`) — never at import. */
const alias = (): string => prodBaseUrl();
const TAG = "[probe:r6-restate-delta]";

const res = await fetch(`${alias()}/api/series?id=R6&limit=4000`, { headers: { "Cache-Control": "no-cache" } });
if (!res.ok) throw new Error(`${TAG} /api/series?id=R6 → HTTP ${res.status}`);
const points = ((await res.json()) as { points: Array<{ date: string; value: number; state: string }> }).points;
if (points.length === 0) throw new Error(`${TAG} served series is EMPTY`);

const indicator: Indicator | undefined = ALL_INDICATORS.find((i) => i.id === "R6");
if (!indicator) throw new Error(`${TAG} R6 is not registered`);

const values = points.map((p) => p.value);
const dates = points.map((p) => p.date);

const { velWindow, velSigmaWindow, measure, zAmber, zRed } = R6_DESCRIPTOR.scorer.constants;
const velZ = oatVelocityZ(values, { velWindow, velSigmaWindow, measure });
const velLeg = (i: number): State => (velZ[i] === undefined ? "GREEN" : highBandState(velZ[i], zAmber, zRed));
const or = (...legs: State[]): State =>
  legs.reduce<State>((acc, s) => combineLevelVelocity(R6_DESCRIPTOR.combine ?? "or", acc, s), "GREEN");

/** AFTER — the LIVE two-leg fold: velocity ∨ absolute, no level band. */
function afterRibbon(): Array<State | undefined> {
  const base = velSigmaWindow + velWindow;
  const out = new Array<State | undefined>(values.length).fill(undefined);
  for (let i = base; i < values.length; i++) out[i] = or(velLeg(i), fixedLevelState(indicator!, values[i]!));
  return out;
}

/** BEFORE — the same fold with the retired N1 percentile leg OR'd back in. */
function beforeRibbon(): Array<State | undefined> {
  const lb = RETIRED_N1_BAND;
  const base = Math.max(levelBandHead(lb), velSigmaWindow + velWindow);
  const lvValues = levelBandValues(values, lb);
  const amberCuts = levelBandCuts(lvValues, lb, lb.amberP);
  const redCuts = levelBandCuts(lvValues, lb, lb.redP);
  const out = new Array<State | undefined>(values.length).fill(undefined);
  for (let i = base; i < values.length; i++) {
    const lv = percentileLevelState(indicator!.id, lvValues[i]!, amberCuts[i]!, redCuts[i]!, "HIGH");
    out[i] = or(lv, velLeg(i), fixedLevelState(indicator!, values[i]!));
  }
  return out;
}

const after = afterRibbon();
const before = beforeRibbon();

// --- the pin: AFTER must reproduce the real scorer where both are defined -------------------
const real = new Map(moveReadingSeriesFromValues(indicator, values, dates).map((r) => [r.date, r.rawState]));
let pinned = 0;
const drift: string[] = [];
for (let i = 0; i < dates.length; i++) {
  const r = real.get(dates[i]!);
  if (r === undefined || after[i] === undefined) continue;
  pinned++;
  if (r !== after[i]) drift.push(`${dates[i]} scorer=${r} probe=${after[i]}`);
}
if (pinned === 0) throw new Error(`${TAG} PIN VACUOUS — no overlapping day to compare the fold against the scorer`);
if (drift.length > 0) {
  console.log(`${TAG} PIN FAILED — the probe's fold has drifted from moveLegSeries on ${drift.length}/${pinned} day(s):`);
  for (const d of drift.slice(0, 10)) console.log(`    ${d}`);
  process.exit(1);
}
console.log(`${TAG} pin OK — the fold reproduces moveReadingSeriesFromValues on all ${pinned} comparable day(s).`);

// --- the delta -------------------------------------------------------------------------------
const duty = (r: Array<State | undefined>, from: number): Record<string, number> => {
  const c: Record<string, number> = {};
  for (let i = from; i < r.length; i++) if (r[i]) c[r[i]!] = (c[r[i]!] ?? 0) + 1;
  return c;
};
const firstBoth = dates.findIndex((_, i) => before[i] !== undefined && after[i] !== undefined);
if (firstBoth < 0) throw new Error(`${TAG} no day is scoreable under BOTH folds — served window too short`);
const n = dates.length - firstBoth;
const pct = (c: Record<string, number>): string =>
  ["GREEN", "AMBER", "RED"].map((s) => `${s} ${c[s] ?? 0} (${(((c[s] ?? 0) / n) * 100).toFixed(1)}%)`).join(" · ");

const moved: Array<{ date: string; before: State; after: State; value: number }> = [];
for (let i = firstBoth; i < dates.length; i++) {
  if (before[i] !== after[i]) moved.push({ date: dates[i]!, before: before[i]!, after: after[i]!, value: values[i]! });
}
const RANK: Record<State, number> = { GREEN: 0, AMBER: 1, RED: 2 };
const softened = moved.filter((m) => RANK[m.after] < RANK[m.before]).length;

console.log(
  `${TAG} prod served ${points.length} row(s) ${dates[0]}→${dates.at(-1)}; ` +
    `${n} day(s) scoreable under BOTH folds (from ${dates[firstBoth]}).`,
);
console.log(`${TAG} BEFORE (N1 level-pct ∨ vel ∨ abs): ${pct(duty(before, firstBoth))}`);
console.log(`${TAG} AFTER  (vel ∨ abs, live)         : ${pct(duty(after, firstBoth))}`);
console.log(
  `${TAG} DELTA: ${moved.length}/${n} day(s) moved (${((moved.length / n) * 100).toFixed(1)}%) — ` +
    `${softened} softer, ${moved.length - softened} stricter.`,
);
for (const m of moved.slice(0, 40)) console.log(`    ${m.date} MOVE ${m.value.toFixed(2)}  ${m.before} → ${m.after}`);
if (moved.length > 40) console.log(`    … ${moved.length - 40} more`);

// --- attribution: what the deleted leg was carrying on its own --------------------------------
// Every moved day IS a solo-N1 day by construction (the OR means the two folds can only differ where
// N1 outranked vel ∨ abs), so the interesting number is the LEVEL those solo calls fired at: that is
// the [USER] complaint this deletion answers — "triggering at very low level of value".
{
  let soloRedMax = 0;
  let soloAmberMax = 0;
  for (const m of moved) {
    if (m.before === "RED") soloRedMax = Math.max(soloRedMax, m.value);
    if (m.before === "AMBER") soloAmberMax = Math.max(soloAmberMax, m.value);
  }
  const { amberLevel, redLevel } = indicator.thresholds ?? {};
  console.log(
    `${TAG} ATTRIBUTION: highest MOVE close taking a solo-N1 RED ${soloRedMax.toFixed(2)}` +
      (typeof redLevel === "number" ? ` (absolute RED cut ${redLevel})` : "") +
      `; solo-N1 AMBER ${soloAmberMax.toFixed(2)}` +
      (typeof amberLevel === "number" ? ` (absolute AMBER cut ${amberLevel})` : "") +
      ". A solo call far UNDER its absolute cut is the leg reading calm-window rank as danger.",
  );
}
