/**
 * Read-only PROD probe: what does the §11.1 GEO **factor** count actually change on the record?
 * Written 2026-08-01 under a rule that forbids calling this floor change verified off `sim:notify` — that harness
 * synthesizes single closes with `geoFlags = 0`, no persisted state and no declared stage, so a
 * green sim is structurally blind to this floor (`research-probes.md` §`sim:notify` is not evidence).
 *
 *     bash scripts/with-prod-config.sh tsx scripts/probe-geo-floor.ts        # reads the prod config, WRITES NOTHING
 *
 * ⚠ **PROD, not dev** (`research-probes.md` §The instrument is a claim too): the dev DB has no cron, so its GEO history is stale
 * by construction and a before/after measured there would be an artifact of the last backfill.
 *
 * THE TWO ARMS (they must not collapse to A/A):
 *   • CONTROL (old rule) — reimplemented HERE as a literal, never imported: the auto term was the
 *     COUNT OF LIT GEO READINGS, and the floor was `base >= 2 ? WARNING : base >= 1 ? WATCH : OK`.
 *     Both cuts are frozen in `oldGeoFloor` below, and so is the stage table (`OLD_STAGE_TO_FLAGS`)
 *     — importing `STAGE_TO_FLAGS` would let a later stage retune silently re-base the baseline.
 *   • ARM (new rule) — the SHIPPED `escalatorFloorBreakdown` (src/alert-band.ts), called with
 *     readings built from the SHIPPED registry descriptors. Calling production here is deliberate:
 *     it is what makes the falsifier below able to detect "the change is not actually live".
 *
 * THE REPLAY ARM HOLDS manual = 0 AND stage = 0 — and that is a MEASUREMENT DECISION, not an
 * oversight. `config.json` is a redeploy-time input with no per-day history (`geo.ts`), so there is
 * nothing to replay; and today's live values (1 manual flag + stage 2 ⇒ +2) already sum to 3, which
 * saturates the `>= 2` cut on EVERY day and would mask the auto term entirely. The replay therefore
 * isolates the term this change touches. The live world is measured separately in §4 below, with
 * the real manual/stage read off `loadGeoInputs()` — the two sections answer different questions.
 *
 * GUARDS (each can exit non-zero — see the CAN-FIRE DEMO at the bottom of this block):
 *   G1 EMPTY READ — zero joined GEO days ⇒ THROW. A run over an empty window would print
 *      "0 flips" and read like a falsified change when it in fact measured nothing.
 *   G2 FALSIFIER (pre-registered) — the audit
 *      measured BRENT lit ~23% of days and OVX ~44% with G1 ⊂ BRENT ⊂ OVX, so co-lit oil days EXIST and the
 *      factor count MUST collapse some of them. A ZERO flipped-day count therefore falsifies the change being
 *      live (predicate not reached / wrong readings array / wrong series) ⇒ THROW, not a pass.
 *   G3 POPULATION NON-EMPTY — the flip count is a counterfactual over co-lit days; if NO day in the
 *      window ever had two lit GEO reads, the flip count is 0 for a reason that has nothing to do
 *      with the rule, so the guard is pinned to the DISCRIMINATING column (co-lit days), not to the
 *      total (`testing-project.md` §A guard's vacuity anchor must not certify the thing it exists to catch).
 *   G4 ARMS-DISTINCT — the arms are also asserted to disagree on at least one day, which is the
 *      A/A collapse check stated in its own terms.
 *
 * CAN-FIRE DEMO — run against prod 2026-08-01, stderr quoted VERBATIM, every mutation restored by
 * re-typing (never `git checkout --`). G1 is not demoed (it needs an empty prod DB); G2 and G3 are
 * the two that carry the verdict, and both were driven red:
 *   • G2, by reverting the ARM inside `newGeoFloor` to the control's per-reading count: exit 1 —
 *     `Error: [probe-geo-floor] ZERO days out of 3771 changed geo floor, across 63 co-lit days.`
 *     `The §11.1 factor count is NOT live on this path (predicate not reached, wrong readings`
 *     `array, or wrong series) — this is the plan's pre-registered falsifier and a STOP, not a pass.`
 *   • G3, by narrowing the window to the newest row per id (`SERIES_LIMIT = 1`): exit 1 —
 *     `Error: [probe-geo-floor] not one of the 2 joined days had two or more lit GEO reads, so the`
 *     `factor count had nothing to collapse and a 0-flip result says nothing about the rule.`
 */
import { getStore } from "../src/store.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { escalatorFloorBreakdown, formatGeoBasis } from "../src/alert-band.js";
import { loadGeoInputs } from "../src/geo.js";
import type { AlertLevel } from "../src/ladder.js";
import type { Indicator, Reading, State } from "../src/domain-types.js";
import { pct } from "./lib/stats.js";
import { readEnv } from "../src/config.js";

/** Newest-N cap per id. Prod history is far short of this; it exists so the read is bounded. */
const SERIES_LIMIT = 20000;

/** CONTROL LITERAL (frozen 2026-08-01) — the pre-§11.1 stage table. Deliberately NOT imported
 *  from `alert-band.ts`: a later stage retune must move the ARM only, never the baseline. */
const OLD_STAGE_TO_FLAGS = [0, 1, 2, 2, 1] as const;

/**
 * CONTROL ARM, frozen as an in-probe literal — the geo floor as it stood BEFORE §11.1:
 * base = manual flags + **one per lit GEO READING** + the stage's flags, cut at 2 ⇒ WARNING,
 * 1 ⇒ WATCH. Every number in this function is a literal on purpose (see the docblock).
 */
function oldGeoFloor(manual: number, litReadingCount: number, stage: number): { base: number; floor: AlertLevel } {
  const stageFlags = OLD_STAGE_TO_FLAGS[stage] ?? 0;
  const base = manual + litReadingCount + stageFlags;
  return { base, floor: base >= 2 ? "WARNING" : base >= 1 ? "WATCH" : "OK" };
}

const isLit = (s: State): boolean => s !== "GREEN";

/** The shipped GEO-channel roster and its factor tags — read off the registry, never hand-typed. */
const GEO_INDICATORS: Indicator[] = ALL_INDICATORS.filter((i) => i.channel === "GEO");

const INDICATOR_BY_ID = new Map(ALL_INDICATORS.map((i) => [i.id, i]));

/** A stored point turned into the `Reading` shape the production floor consumes. Only the fields
 *  the floor reads are load-bearing (`indicator`, `state`); the rest carry the stored values. */
function toReading(indicator: Indicator, date: string, value: number, delta20: number, rawState: State, state: State): Reading {
  return { indicator, date, level: value, delta20, rawState, state };
}

/** Geo floor under the SHIPPED rule, via production. */
function newGeoFloor(
  readings: Reading[],
  manual: number,
  stage: number,
): { level: AlertLevel; basis: string; total: number; autoFactors: number } {
  const bd = escalatorFloorBreakdown(readings, manual, "equity", false, false, stage);
  const geo = bd.floors.find((f) => f.id === "geo")!;
  const basis = geo.geoBasis!;
  return { level: geo.level, basis: formatGeoBasis(basis), total: basis.total, autoFactors: basis.autoFactors };
}

function dist(levels: AlertLevel[]): string {
  const order: AlertLevel[] = ["OK", "WATCH", "WARNING", "CRITICAL"];
  const n = levels.length;
  return order
    .map((l) => `${l} ${String(levels.filter((x) => x === l).length).padStart(5)} (${pct(levels.filter((x) => x === l).length / n)})`)
    .join("   ");
}

async function main(): Promise<void> {
  const env = readEnv();
  const store = getStore("ro", env);

  console.log("═".repeat(100));
  console.log(`GEO FLOOR — per-reading count (CONTROL, in-probe literal) vs per-FACTOR count (ARM, shipped)`);
  console.log(`stored PROD series (readings_latest), read-only\n`);
  console.log(`GEO-CHANNEL ROSTER (off the shipped registry, ${GEO_INDICATORS.length} ids):`);
  for (const i of GEO_INDICATORS) {
    console.log(`  ${i.id.padEnd(8)} factor=${(i.geoFactor ?? `(UNTAGGED → counts as "${i.id}")`).padEnd(24)} ${i.label}`);
  }

  // ── §1/§2 real-close replay ────────────────────────────────────────────────────────────────
  const ids = GEO_INDICATORS.map((i) => i.id);
  const series = await store.getSeriesBulk(ids, { limit: SERIES_LIMIT });
  console.log(`\nSTORED ROWS:`);
  for (const id of ids) {
    const s = series.get(id) ?? [];
    console.log(
      s.length === 0
        ? `  ${id.padEnd(8)}      0 rows   ⚠ NOT STORED IN PROD`
        : `  ${id.padEnd(8)} ${String(s.length).padStart(6)} rows   ${s[0]!.date} → ${s.at(-1)!.date}   ` +
          `lit (non-GREEN) on ${s.filter((p) => isLit(p.state)).length} (${pct(s.filter((p) => isLit(p.state)).length / s.length)})   latest state ${s.at(-1)!.state}`,
    );
  }

  const dates = [...new Set(ids.flatMap((id) => (series.get(id) ?? []).map((p) => p.date)))].sort();
  // G1 EMPTY READ.
  if (dates.length === 0) {
    throw new Error(
      `[probe-geo-floor] zero joined GEO days over ids ${ids.join(", ")} — this run measured NOTHING, ` +
        `so its "0 flips" would falsify the change for the wrong reason. Check the DB target (.env.prod) ` +
        `and the stored-row inventory above.`,
    );
  }
  const byId = new Map(ids.map((id) => [id, new Map((series.get(id) ?? []).map((p) => [p.date, p]))]));

  const oldLevels: AlertLevel[] = [];
  const newLevels: AlertLevel[] = [];
  let flipped = 0;
  let coLit = 0;
  let warningDrops = 0;
  let brentOvxLitG1Green = 0;
  const examples: string[] = [];

  for (const date of dates) {
    const readings: Reading[] = [];
    for (const ind of GEO_INDICATORS) {
      const p = byId.get(ind.id)!.get(date);
      if (p) readings.push(toReading(ind, date, p.value, p.delta20, p.rawState, p.state));
    }
    const litIds = readings.filter((r) => isLit(r.state)).map((r) => r.indicator.id);
    if (litIds.length >= 2) coLit++;
    const before = oldGeoFloor(0, litIds.length, 0);
    const after = newGeoFloor(readings, 0, 0);
    oldLevels.push(before.floor);
    newLevels.push(after.level);
    const g1 = readings.find((r) => r.indicator.id === "G1");
    const nestedCase = litIds.includes("BRENT") && litIds.includes("OVX") && g1 !== undefined && g1.state === "GREEN";
    if (nestedCase) brentOvxLitG1Green++;
    if (before.floor !== after.level) {
      flipped++;
      if (before.floor === "WARNING") warningDrops++;
      if (examples.length < 5) {
        examples.push(
          `    ${date}  lit=[${litIds.join(", ")}]  base ${before.base} → ${after.total}  ` +
            `floor ${before.floor} → ${after.level}${nestedCase ? "   ← BRENT+OVX lit, G1 GREEN" : ""}`,
        );
      }
    }
  }

  // G3 POPULATION NON-EMPTY — pinned to the DISCRIMINATING column (co-lit days), not the total.
  if (coLit === 0) {
    throw new Error(
      `[probe-geo-floor] not one of the ${dates.length} joined days had two or more lit GEO reads, so the ` +
        `factor count had nothing to collapse and a 0-flip result says nothing about the rule. Widen the ` +
        `window / check the stored states before reading any line of this output.`,
    );
  }
  // G2 PRE-REGISTERED FALSIFIER.
  if (flipped === 0) {
    throw new Error(
      `[probe-geo-floor] ZERO days out of ${dates.length} changed geo floor, across ${coLit} co-lit days. ` +
        `The §11.1 factor count is NOT live on this path (predicate not reached, wrong readings array, or ` +
        `wrong series) — this is the plan's pre-registered falsifier and a STOP, not a pass.`,
    );
  }
  // G4 ARMS-DISTINCT — restated in its own terms: the control must not be the arm.
  if (oldLevels.every((l, i) => l === newLevels[i])) {
    throw new Error(`[probe-geo-floor] the two arms agree day-for-day — they have collapsed to A/A.`);
  }

  console.log(`\n${"─".repeat(100)}\n(1) FLIPPED DAYS   ${flipped} / ${dates.length} (${pct(flipped / dates.length)})   ` +
    `${dates[0]} → ${dates.at(-1)}`);
  console.log(`    of which WARNING → lower: ${warningDrops}   co-lit (≥2 lit reads) days: ${coLit}   ` +
    `days with BRENT+OVX lit and G1 GREEN: ${brentOvxLitG1Green}`);
  console.log(`    first flips:\n${examples.join("\n")}`);

  console.log(`\n(2) FLOOR DISTRIBUTION (replay arm: manual 0, stage 0 — see docblock)`);
  console.log(`    BEFORE (per-reading)  ${dist(oldLevels)}`);
  console.log(`    AFTER  (per-factor)   ${dist(newLevels)}`);

  const latest = dates.at(-1)!;
  const latestReadings: Reading[] = [];
  for (const ind of GEO_INDICATORS) {
    const p = byId.get(ind.id)!.get(latest);
    if (p) latestReadings.push(toReading(ind, latest, p.value, p.delta20, p.rawState, p.state));
  }
  const latestLit = latestReadings.filter((r) => isLit(r.state)).map((r) => r.indicator.id);
  const latestBefore = oldGeoFloor(0, latestLit.length, 0);
  const latestAfter = newGeoFloor(latestReadings, 0, 0);
  console.log(`\n(3) LATEST STORED DAY ${latest} — full breakdown (replay arm: manual 0, stage 0)`);
  for (const r of latestReadings) {
    console.log(
      `    ${r.indicator.id.padEnd(8)} state ${r.state.padEnd(6)} raw ${r.rawState.padEnd(6)} value ${r.level.toFixed(4).padStart(12)}  factor=${r.indicator.geoFactor ?? "(untagged)"}`,
    );
  }
  const missing = GEO_INDICATORS.filter((i) => !latestReadings.some((r) => r.indicator.id === i.id)).map((i) => i.id);
  if (missing.length > 0) console.log(`    (no row on ${latest}: ${missing.join(", ")})`);
  console.log(`    lit reads: [${latestLit.join(", ")}]  (${latestLit.length})`);
  console.log(`    BEFORE  base ${latestBefore.base}  floor ${latestBefore.floor}`);
  console.log(`    AFTER   base ${latestAfter.total}  floor ${latestAfter.level}   basis: ${latestAfter.basis}`);

  // ── §4 stated re-score of the LIVE band ────────────────────────────────────────────────────
  const { flagCount, crisisStage } = loadGeoInputs();
  const alert = await store.getLastAlert();
  console.log(`\n${"─".repeat(100)}\n(4) STATED RE-SCORE OF THE LIVE BAND — real manual/stage off config.json (src/geo.ts)`);
  console.log(`    manual flags ${flagCount}   crisisStage ${crisisStage} ⇒ stage flags ${OLD_STAGE_TO_FLAGS[crisisStage] ?? 0}`);
  if (alert === null) {
    console.log(`    ⚠ no stored alert row in prod — the live band cannot be re-scored from the record.`);
  } else {
    const stored = await store.getReadingsForRun(alert.firedAt);
    const liveReadings: Reading[] = stored
      .filter((s) => INDICATOR_BY_ID.has(s.indicatorId))
      .map((s) => toReading(INDICATOR_BY_ID.get(s.indicatorId)!, s.date, s.value, s.delta20, s.rawState, s.state));
    const liveLitGeo = liveReadings.filter((r) => r.indicator.channel === "GEO" && isLit(r.state)).map((r) => r.indicator.id);
    const fired = alert.dialState?.fired ?? false;
    const ew = alert.dialState?.fastBreakEW ?? false;
    const r4 = alert.r4Phase ?? "equity";
    const bd = escalatorFloorBreakdown(liveReadings, flagCount, r4, fired, ew, crisisStage);
    const geoAfter = bd.floors.find((f) => f.id === "geo")!;
    const geoBefore = oldGeoFloor(flagCount, liveLitGeo.length, crisisStage);
    console.log(
      `    run ${alert.date} (fired ${alert.firedAt})   persisted band ${alert.level} · reason ${alert.bandReason ?? "—"} · ` +
        `dialBand ${alert.dialBand ?? "—"} · r4Phase ${r4} · dial.fired ${fired} · fastBreakEW ${ew}`,
    );
    console.log(`    live lit GEO reads: [${liveLitGeo.join(", ")}] (${liveLitGeo.length})`);
    console.log(`    GEO FLOOR  BEFORE base ${geoBefore.base} ⇒ ${geoBefore.floor}    AFTER base ${geoAfter.geoBasis!.total} ⇒ ${geoAfter.level}`);
    console.log(`    AFTER basis: ${formatGeoBasis(geoAfter.geoBasis!)}`);
    console.log(`    ALL FLOORS (AFTER, most-severe-first ⇒ tie precedence):`);
    for (const f of bd.floors) console.log(`      ${f.id.padEnd(7)} ${f.level}`);
    console.log(`    binding floor AFTER: ${bd.source ?? "(none — every floor OK)"} ⇒ ${bd.band}`);
    const othersBefore = bd.floors.filter((f) => f.id !== "geo").map((f) => f.level);
    console.log(
      `    NON-GEO floors: [${othersBefore.join(", ")}]   persisted dialBand ${alert.dialBand ?? "—"} — ` +
        `if any of these sits at or above the geo floor, the PUSHED band does not move whatever geo does.`,
    );
    if (geoBefore.floor === geoAfter.level) {
      console.log(`    ⇒ the geo floor itself is UNCHANGED (${geoAfter.level}) under the live manual+stage addends.`);
    } else {
      console.log(`    ⇒ geo floor moves ${geoBefore.floor} → ${geoAfter.level}.`);
    }
    if (geoAfter.geoBasis!.autoFactors === 0 && liveLitGeo.length > 0) {
      throw new Error(
        `[probe-geo-floor] the live auto term collapsed to 0 while ${liveLitGeo.length} GEO reads are lit ` +
          `([${liveLitGeo.join(", ")}]). That is the USER-DECLINED weight-gate's outcome, not this rule's — ` +
          `a BUG in the change, not a better result.`,
      );
    }
  }

  console.log(`\n${"═".repeat(100)}\nDONE — read-only, nothing written.`);
}

await main();
