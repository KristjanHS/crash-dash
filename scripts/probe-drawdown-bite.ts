/**
 * W5-e Phase A-2 — the FAITHFUL BITE probe.
 *
 *   npm run probe:drawdown-bite            # local dev stack must be UP (scripts/db.sh up dev)
 *   scripts/db.sh with dev -- npm run probe:drawdown-bite
 *
 * WHY THIS EXISTS (§3, §4 A-2, §8 Option A ruling). The archived engagement probe
 * (`probe-drawdown-gate.ts`) measured how often the drawdown gate would have been ON (engagement),
 * NOT how often it would have CLAMPED an actual `>±1` rung move (BITE). Bite is the intersection of
 * "gate fires" with "the dial wants a `>±1` step", and the clamp is calibrated against bite, not
 * engagement. Bite needs the FAITHFUL rung path, which is driven by the full DIAL_FAMILIES member
 * panel → computeT1Dial → computeField → decideRotationHold — reconstructable only over the persisted DB
 * panel (Option A). `replay.ts` offline cannot produce it (~half the panel has no committed fixture).
 *
 * FAITHFULNESS. The dial + field + decideRotationHold are the SHIPPED functions, folded per close over the
 * forward-filled DB member panel. The failOff boolean is JOINED BY DATE from the A-1 walk() (the
 * exact live gate boolean via production classifyFallShape over the committed hyoas.csv). Master date
 * axis = acwi.csv obs dates (failOff's domain). Early closes where the DB panel is too thin to
 * produce a faithful pillar-live dial → bite reported as ≤ failOff (a true ceiling, bite ⊆ failOff).
 *
 * ⚠ STRICTLY READ-ONLY: getSeries selects only — never insert/update/delete. ABORT-loud on any
 * member fetch throw (a partial panel is not a calibration).
 *
 * Data-pull + forward-fill come from `scripts/lib/replay-walk.ts` (`loadSeries` / `coverageOf` /
 * `makeCursor` / `panelAt`). The per-close LOOP stays here — see the SEAM comment above it.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { computeFamilyPanel, LADDER } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import { computeField, trendConfirming } from "../src/danger-engine.js";
import { buildMemberState } from "../src/danger-member-state.js";
import { decideRotationHold } from "../src/rotation-commit.js";
import { readFixture } from "./backtest/drift-guard.js";
import { walk, loadF1States, EPISODES, FULL_WINDOW_FROM } from "./probe-drawdown-gate.js";
import { loadSeries, coverageOf, makeCursor, panelAt, MEMBER_WINDOW } from "./lib/replay-walk.js";

// Extra leading history beyond the member-history window, so each member's sub-severity history
// has its lookback settled at the left edge. Re-declared locally: `MEMBER_HISTORY_PAD` is a private
// const in `dial-assembly.ts` (=30); this MUST track it (window fed to computeField = 60+30 = 90).
const MEMBER_HISTORY_PAD = 30;

const ACWI_FIXTURE = "scripts/backtest/data/acwi.csv";
const SNAPSHOT_PATH = "scripts/probe-drawdown-bite.snapshot.json";
/** Grab full DB depth per member — acwi spans ~4785 closes; this over-reaches it deliberately. */
const FETCH_LIMIT = 20_000;

// ---------- 1. failOff series (reuse A-1) ----------
// SEAM (Stage 3.C-1): `calendarFrom`/`unionCalendar` are DECLINED — the axis is this fixture's obs
// dates, not a store series. `selectReplayDates` is DECLINED too: this probe walks the WHOLE axis and
// takes no `--closes`/`--from`/`--to`, so adopting it would add three unreachable aborts and a
// `CALENDAR_MARGIN` floor the probe has no argument to drive.
const acwiObs = readFixture(ACWI_FIXTURE);
if (acwiObs.length === 0) {
  console.log(`ABORT: ${ACWI_FIXTURE} parsed to 0 observations — nothing to walk.`);
  process.exit(1);
}
const failOffRows = walk(acwiObs, loadF1States());
const failOffByDate = new Map<string, boolean | null>(failOffRows.map((r) => [r.date, r.failOff]));

// ---------- 2. DB panel reconstruction ----------
let store;
try {
  store = await resolveStore("local", "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no local store reachable — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The dev stack defaults DOWN — re-run under the front door:\n` +
      `      scripts/db.sh with dev -- npm run probe:drawdown-bite\n` +
      `    (or hold it open with \`scripts/db.sh up dev\`).`,
  );
  process.exit(1);
}

// A member that silently resolves to [] is absent for EVERY date — a rung path over a partial panel
// is not a calibration. `loadSeries` fails loud rather than calibrate bite against a hole.
const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeries(store, memberIds, FETCH_LIMIT);

// ---------- coverage (snapshot only — this probe prints no coverage block) ----------
const coverage = coverageOf(seriesById, memberIds);

// ---------- per-member forward-fill cursor ----------
// One cursor shared across the ascending acwi walk (`panelAt`'s non-decreasing-`d` invariant holds).
const cursor = makeCursor(seriesById);

// ---------- 3. per-close reconstruction over the acwi axis ----------
const rungOf = (s: string): number => (LADDER as readonly string[]).indexOf(s) + 1; // 0 = absent

interface CloseRow {
  date: string;
  faithful: boolean; // dial.pillarsLive — the reconstructed dial is fed by every live pillar family
  prevRung: number;
  candidateRung: number;
  requestedMove: number;
  failOff: boolean | null;
  bite: boolean;
  direction: "de-risk" | "re-risk" | null;
  withheld: number; // |requestedMove| − 1 rungs the clamp would withhold on a bite
}
const rows: CloseRow[] = [];

let prevHeld: string | null = null;
let prevConfirmCount = 0;
let prevHeldDays = 0;

// SEAM (Stage 3.C-1): the loop stays in-probe — `walkReplay`'s fold does not apply. The axis is the
// tracked `acwi.csv` fixture (not a store calendar), and the fold state is `prevHeld`/`prevConfirmCount`/
// `prevHeldDays` hysteresis threaded through `decideRotationHold`, which is a decision gate and stays here.
for (const { date: d } of acwiObs) {
  // 1. members present, forward-filled to d (inclusive ffill horizon, mirrors replay.ts) + 5. the
  //    faithful member history (reconstructed offline, NOT an empty `cissHistory`): per present member, its
  //    series sliced to points ≤ d, last MEMBER_WINDOW+MEMBER_HISTORY_PAD (=90) points.
  const { readings, cissHistory } = panelAt(seriesById, memberIds, d, {
    historyLen: MEMBER_WINDOW + MEMBER_HISTORY_PAD,
    cursor,
  });

  // 2-4. panel → tech confirmer → dial (the SHIPPED reduction).
  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
  const dial = computeT1Dial(panel.families, techP);

  // 6-7. prior rung.
  const prevRung = prevHeld ? rungOf(prevHeld) : 0;
  const prevTarget = prevRung > 0 ? prevRung : null;

  // 8. the danger field (the arg is named globalFamilies but it IS the DIAL_FAMILIES panel — §11).
  const field = computeField({ globalFamilies: panel.families }, dial.band, undefined, prevTarget, cissHistory);

  // 9. candidate sleeve/rung.
  const dialSleeve = LADDER[dial.targetRung - 1] ?? LADDER[LADDER.length - 1]!;
  const candidateSleeve = field.held?.sleeve ?? dialSleeve;
  const candidateRung = rungOf(candidateSleeve);

  // ⚠ RE-BASELINED 2026-08-07. `decideRotationHold`'s re-risk
  // condition lost BOTH timing gates (RERISK_CONFIRM 2→1, RERISK_DWELL_DAYS 3→0) and the `improving`
  // term, and this call omits `gates` — so a run today replays with NO timing gate at all and is NOT
  // row-comparable with the recorded "1 de-risk hit/18y, 0 in 2022, redundant with M8" figures.
  // Pass `gates: LEGACY_RERISK_GATES` (danger-ladder.ts — the frozen {2, 3, requireImproving} triple)
  // to reproduce the pre-2026-08-07 decision. Not re-run/re-baselined here (2026-08-07 review).
  // 10. re-risk gates.
  const improving = prevTarget != null && dial.targetRung < prevTarget;
  const trendOk = trendConfirming(buildMemberState({ globalFamilies: panel.families }));

  // 11. commit (carry decision state forward). newClose always true — the probe walks distinct closes.
  // `drawdownGateFires: false` is DELIBERATE: bite measures how often the W5-e clamp WOULD have bitten
  // the UN-clamped historical rung path (the requested move BEFORE any clamp). Carrying the clamped
  // path here would measure the post-clamp world instead of calibrating against the real history.
  const decision = decideRotationHold({
    candidateSleeve,
    prevHeld,
    prevRung,
    candidateRung,
    improving,
    trendOk,
    prevConfirmCount,
    prevHeldDays,
    newClose: true,
    drawdownGateFires: false,
  });

  // 12. requested move (BEFORE decideRotationHold gates it) + failOff join.
  const requestedMove = candidateRung - prevRung;
  const failOff = failOffByDate.get(d) ?? null;

  // Bite (§9 bidirectional): gate fires AND the dial wants a >±1 step AND there is a prior hold.
  const bite = failOff === true && prevRung > 0 && Math.abs(requestedMove) > 1;
  const direction: "de-risk" | "re-risk" | null = bite
    ? requestedMove > 1
      ? "de-risk"
      : "re-risk"
    : null;

  rows.push({
    date: d,
    faithful: dial.pillarsLive,
    prevRung,
    candidateRung,
    requestedMove,
    failOff,
    bite,
    direction,
    withheld: bite ? Math.abs(requestedMove) - 1 : 0,
  });

  prevHeld = decision.heldSleeve;
  prevConfirmCount = decision.reriskConfirmCount;
  prevHeldDays = decision.heldDays;
}

// ---------- 4. aggregation ----------
const faithfulFloor = rows.find((r) => r.faithful)?.date ?? null;

function withheldDist(subset: CloseRow[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of subset) {
    if (!r.bite) continue;
    const k = String(r.withheld);
    dist[k] = (dist[k] ?? 0) + 1;
  }
  return dist;
}

interface Figures {
  closes: number;
  faithfulCloses: number; // pillar-live closes — bite is MEASURED here
  ceilingCloses: number; // thin-panel closes — bite ≤ failOff, unmeasured
  bite: number;
  deRiskBite: number;
  reRiskBite: number;
  withheldStepDist: Record<string, number>;
  /** failOff count over the CEILING (thin-panel) closes — the ceiling bite ≤ this. */
  ceilingFailOff: number;
}
function figures(subset: CloseRow[]): Figures {
  const faithful = subset.filter((r) => r.faithful);
  const ceiling = subset.filter((r) => !r.faithful);
  const bites = faithful.filter((r) => r.bite);
  return {
    closes: subset.length,
    faithfulCloses: faithful.length,
    ceilingCloses: ceiling.length,
    bite: bites.length,
    deRiskBite: bites.filter((r) => r.direction === "de-risk").length,
    reRiskBite: bites.filter((r) => r.direction === "re-risk").length,
    withheldStepDist: withheldDist(faithful),
    ceilingFailOff: ceiling.filter((r) => r.failOff === true).length,
  };
}

interface EpisodeFig extends Figures {
  name: string;
  from: string;
  to: string;
  belowFloor: boolean; // zero faithful closes ⇒ ceiling-only ("≤ failOff ceiling, unmeasured")
}
const perEpisode: EpisodeFig[] = EPISODES.map((ep) => {
  const slice = rows.filter((r) => r.date >= ep.from && r.date <= ep.to);
  const f = figures(slice);
  return { name: ep.name, from: ep.from, to: ep.to, belowFloor: f.faithfulCloses === 0, ...f };
});

const overall = figures(rows);

const snapshot = {
  probe: "W5-e A-2 faithful bite",
  generatedFrom: {
    acwiFixture: ACWI_FIXTURE,
    acwiCloses: acwiObs.length,
    acwiSpan: [acwiObs[0]!.date, acwiObs.at(-1)!.date],
    fullWindowFrom: FULL_WINDOW_FROM,
    biteDefinition: "failOff===true && prevRung>0 && |candidateRung−prevRung|>1 (bidirectional, §9)",
  },
  faithfulFloor,
  overall,
  perEpisode,
  coverage,
};

writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");

// ---------- 5. report ----------
console.log(`W5-e A-2 faithful bite probe — env=local`);
console.log(`acwi axis: ${acwiObs.length} closes  ${acwiObs[0]!.date} .. ${acwiObs.at(-1)!.date}`);
console.log(`faithful floor (first pillar-live dial): ${faithfulFloor ?? "— (never faithful)"}`);
console.log("");
console.log(
  `OVERALL: ${overall.bite} bite closes over ${overall.faithfulCloses} faithful closes ` +
    `(${overall.deRiskBite} de-risk / ${overall.reRiskBite} re-risk); ` +
    `${overall.ceilingCloses} thin-panel closes with failOff ceiling ${overall.ceilingFailOff}`,
);
console.log(`withheld-step dist (rungs→count): ${JSON.stringify(overall.withheldStepDist)}`);
console.log("");
console.log("PER EPISODE:");
console.log(
  "  " +
    "episode".padEnd(16) +
    "faithful".padStart(9) +
    "ceil".padStart(6) +
    "bite".padStart(6) +
    "de".padStart(4) +
    "re".padStart(4) +
    "ceilFailOff".padStart(13) +
    "  note",
);
for (const e of perEpisode) {
  console.log(
    "  " +
      e.name.padEnd(16) +
      String(e.faithfulCloses).padStart(9) +
      String(e.ceilingCloses).padStart(6) +
      String(e.bite).padStart(6) +
      String(e.deRiskBite).padStart(4) +
      String(e.reRiskBite).padStart(4) +
      String(e.ceilingFailOff).padStart(13) +
      (e.belowFloor ? "  ≤ failOff ceiling, unmeasured" : ""),
  );
}
console.log("");
console.log(`wrote snapshot → ${SNAPSHOT_PATH}`);

// ---------- 6. A-2 decision gate (§9) ----------
const nonTrivial = overall.bite >= 1;
console.log("");
console.log(
  nonTrivial
    ? `A-2 GATE: bite is NON-TRIVIAL (${overall.bite} measured bite close(s)) → proceed to Phase B.`
    : `A-2 GATE: bite is ~0 across all measured episodes → STOP and surface the degenerate-gate finding.`,
);
