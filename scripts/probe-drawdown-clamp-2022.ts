/**
 * W5-e Phase C §6 step-2 — the BEHAVIOUR-CHANGE falsifier.
 * Proves the LIVE clamp actually bites: it re-folds the faithful rung path over the 2022 deep
 * drawdown TWICE and asserts the two committed paths DIVERGE.
 *
 *   npm run probe:drawdown-clamp-2022        # local dev stack must be UP (scripts/db.sh up dev)
 *   scripts/db.sh with dev -- npm run probe:drawdown-clamp-2022
 *
 * WHY. A clamp that changes NOTHING on a real
 * deep-drawdown replay is not wired. The grep falsifier (drawdownGateWouldFire hitting run-core.ts's rung seam)
 * proves the wiring EXISTS; this proves it CHANGES the ladder trajectory. Bite COUNTS (A-2) prove the clamp
 * would TRIGGER; this proves the folded 2022 ladder path actually differs.
 *
 * FAITHFULNESS. Mirrors `probe-drawdown-bite.ts` / `probe-cash-overlay.ts`: the dial + field + decideRotationHold
 * are the SHIPPED functions, folded per close over the forward-filled DB member panel; failOff joined by
 * date from the A-1 walk(). Two arms, EACH carrying its own prevHeld forward from the same acwi start:
 *   - baseline: decideRotationHold(..., drawdownGateFires:false)          — today's pre-clamp behaviour
 *   - clamped : decideRotationHold(..., drawdownGateFires: failOff[d])    — the LIVE gate (§9 bidirectional)
 * The clamp is PATH-DEPENDENT — a withheld rung shifts every subsequent prevRung — so the arms are folded
 * independently over the FULL history (the live gate has clamped since the first bite, 2015), and the
 * 2022 slice of both paths is compared. A non-empty diff over 2022 is the falsifier.
 *
 * ⚠ STRICTLY READ-ONLY: getSeries selects only. ABORT-loud on any member fetch throw (a partial panel
 * is not a calibration).
 *
 * Data-pull + forward-fill come from `scripts/lib/replay-walk.ts` (`loadSeries` / `makeCursor` /
 * `panelAt`). The per-close LOOP stays here — see the SEAM comment above it.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { computeFamilyPanel, LADDER } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import {
  computeField,
  trendConfirming,
  type MemberHistoryEntry,
} from "../src/danger-engine.js";
import { buildMemberState } from "../src/danger-member-state.js";
import { decideRotationHold } from "../src/rotation-commit.js";
import { readFixture } from "./backtest/drift-guard.js";
import { walk, loadF1States, EPISODES } from "./probe-drawdown-gate.js";
import { loadSeries, makeCursor, panelAt, MEMBER_WINDOW } from "./lib/replay-walk.js";

// Re-declared locally: MEMBER_HISTORY_PAD is a private const in dial-assembly.ts (=30); this MUST track it
// (window fed to computeField = MEMBER_WINDOW + pad = 60 + 30 = 90). Same as probe-drawdown-bite.ts.
const MEMBER_HISTORY_PAD = 30;

const ACWI_FIXTURE = "scripts/backtest/data/acwi.csv";
const SNAPSHOT_PATH = "scripts/probe-drawdown-clamp-2022.snapshot.json";
const FETCH_LIMIT = 20_000;

// SEAM (Stage 3.C-1): `calendarFrom`/`unionCalendar` are DECLINED — the axis is `acwi.csv`'s obs dates,
// not a store series. `selectReplayDates` is DECLINED too: this probe walks the WHOLE axis and takes no
// `--closes`/`--from`/`--to`, so adopting it would add three unreachable aborts and a `CALENDAR_MARGIN`
// floor the probe has no argument to drive.
const EP_2022 = EPISODES.find((e) => e.name === "2022");
if (!EP_2022) {
  console.log("ABORT: no '2022' episode in EPISODES — cannot slice the falsifier window.");
  process.exit(1);
}

// ---------- 1. failOff series (reuse A-1) ----------
const acwiObs = readFixture(ACWI_FIXTURE);
if (acwiObs.length === 0) {
  console.log(`ABORT: ${ACWI_FIXTURE} parsed to 0 observations — nothing to walk.`);
  process.exit(1);
}
const failOffRows = walk(acwiObs, loadF1States());
const failOffByDate = new Map<string, boolean | null>(failOffRows.map((r) => [r.date, r.failOff]));

// ---------- 2. DB panel reconstruction (mirror probe-drawdown-bite.ts) ----------
let store;
try {
  store = await resolveStore("local", "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no local store reachable — ${e instanceof Error ? e.message : String(e)}\n` +
      `    Re-run under the front door:\n` +
      `      scripts/db.sh with dev -- npm run probe:drawdown-clamp-2022`,
  );
  process.exit(1);
}

const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeries(store, memberIds, FETCH_LIMIT);

// ---------- per-member forward-fill cursor ----------
// One cursor shared across the ascending acwi walk (`panelAt`'s non-decreasing-`d` invariant holds).
// `coverageOf`/`printCoverage` are DECLINED: this probe prints and snapshots no coverage block.
const cursor = makeCursor(seriesById);

const rungOf = (s: string): number => (LADDER as readonly string[]).indexOf(s) + 1; // 0 = absent

// ---------- 3. the two folded arms ----------
// Each arm carries its own committed-leg state forward; the ONLY difference is drawdownGateFires.
interface Arm {
  prevHeld: string | null;
  prevConfirmCount: number;
  prevHeldDays: number;
}
interface Shared {
  panelFamilies: ReturnType<typeof computeFamilyPanel>["families"];
  dial: ReturnType<typeof computeT1Dial>;
  cissHistory: MemberHistoryEntry[];
  trendOk: boolean;
}

type Decision = ReturnType<typeof decideRotationHold>;
interface StepInputs {
  candidateSleeve: string;
  prevRung: number;
  candidateRung: number;
  improving: boolean;
}
/** The decideRotationHold inputs derived from an arm's carried state at this close (gate-independent). */
function stepInputs(arm: Arm, s: Shared): StepInputs {
  const prevRung = arm.prevHeld ? rungOf(arm.prevHeld) : 0;
  const prevTarget = prevRung > 0 ? prevRung : null;
  const field = computeField(
    { globalFamilies: s.panelFamilies },
    s.dial.band,
    undefined,
    prevTarget,
    s.cissHistory,
  );
  const dialSleeve = LADDER[s.dial.targetRung - 1] ?? LADDER[LADDER.length - 1]!;
  const candidateSleeve = field.held?.sleeve ?? dialSleeve;
  return {
    candidateSleeve,
    prevRung,
    candidateRung: rungOf(candidateSleeve),
    improving: prevTarget != null && s.dial.targetRung < prevTarget,
  };
}
// ⚠ RE-BASELINED 2026-08-07. `decideRotationHold`'s re-risk condition
// lost BOTH timing gates (RERISK_CONFIRM 2→1, RERISK_DWELL_DAYS 3→0) and the `improving` term, and this
// call omits `gates` — so a run today replays 2022 with NO timing gate at all and is NOT row-comparable
// with the recorded "1 de-risk hit/18y, 0 in 2022, redundant with M8" figures. Pass
// `gates: LEGACY_RERISK_GATES` (danger-ladder.ts — the frozen {2, 3, requireImproving} triple) to
// reproduce the pre-2026-08-07 decision. Not re-run/re-baselined here (2026-08-07 review).
function commit(arm: Arm, inp: StepInputs, s: Shared, gateFires: boolean): Decision {
  return decideRotationHold({
    candidateSleeve: inp.candidateSleeve,
    prevHeld: arm.prevHeld,
    prevRung: inp.prevRung,
    candidateRung: inp.candidateRung,
    improving: inp.improving,
    trendOk: s.trendOk,
    prevConfirmCount: arm.prevConfirmCount,
    prevHeldDays: arm.prevHeldDays,
    newClose: true,
    drawdownGateFires: gateFires,
  });
}
function carry(arm: Arm, dec: Decision): void {
  arm.prevHeld = dec.heldSleeve;
  arm.prevConfirmCount = dec.reriskConfirmCount;
  arm.prevHeldDays = dec.heldDays;
}

const baseline: Arm = { prevHeld: null, prevConfirmCount: 0, prevHeldDays: 0 };
const clamped: Arm = { prevHeld: null, prevConfirmCount: 0, prevHeldDays: 0 };

interface DiffRow {
  date: string;
  baseRung: number;
  clampRung: number;
  failOff: boolean | null;
}
const window2022: DiffRow[] = [];

// ISOLATED clamp-effect diagnostic (history held EQUAL): at each close, on the baseline arm's carried
// state, run decideRotationHold twice — gate OFF vs gate=failOff — and see if the COMMITTED sleeve differs.
// This isolates "does the clamp change what we commit THIS close" from downstream path divergence, and
// distinguishes a genuinely-inert clamp (M8 pre-empts the re-risk bites) from a probe join bug.
interface ClampHit {
  date: string;
  episode: string | null;
  prevRung: number;
  offRung: number;
  onRung: number;
  failOff: boolean | null;
}
const clampHits: ClampHit[] = [];
let failOffTrueCloses = 0; // sanity: how many closes even HAD the gate on (join liveness)
const episodeOf = (d: string): string | null =>
  EPISODES.find((e) => d >= e.from && d <= e.to)?.name ?? null;

// SEAM (Stage 3.C-1): the loop stays in-probe — `walkReplay`'s fold does not apply. The axis is the
// tracked `acwi.csv` fixture (not a store calendar); the fold carries `prevHeld` hysteresis; and the two
// arms are joined by the `failOff` boolean at DECISION time (inside `decideRotationHold`/`commit`), not at the
// fold layer, so a single `S` walked once would not express them.
for (const { date: d } of acwiObs) {
  // members present, forward-filled to d, + each present member's trailing member-history slice.
  const { readings, cissHistory } = panelAt(seriesById, memberIds, d, {
    historyLen: MEMBER_WINDOW + MEMBER_HISTORY_PAD,
    cursor,
  });

  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
  const dial = computeT1Dial(panel.families, techP);
  const trendOk = trendConfirming(buildMemberState({ globalFamilies: panel.families }));
  const shared: Shared = { panelFamilies: panel.families, dial, cissHistory, trendOk };
  const failOff = failOffByDate.get(d) ?? null;

  if (failOff === true) failOffTrueCloses++;

  // baseline arm — the gate-OFF (pre-clamp) path. ISOLATED diagnostic: on the SAME carried state, also
  // run the gate-ON commit and compare (history held equal), then advance on the gate-OFF result.
  const bIn = stepInputs(baseline, shared);
  const off = commit(baseline, bIn, shared, false);
  const on = commit(baseline, bIn, shared, failOff === true);
  if (off.heldSleeve !== on.heldSleeve) {
    clampHits.push({
      date: d,
      episode: episodeOf(d),
      prevRung: bIn.prevRung,
      offRung: rungOf(off.heldSleeve),
      onRung: rungOf(on.heldSleeve),
      failOff,
    });
  }
  carry(baseline, off);
  const baseRung = rungOf(off.heldSleeve);

  // clamped independent arm — the compounding gate-ON path (§9 bidirectional).
  const cIn = stepInputs(clamped, shared);
  const cDec = commit(clamped, cIn, shared, failOff === true);
  carry(clamped, cDec);
  const clampRung = rungOf(cDec.heldSleeve);

  if (d >= EP_2022.from && d <= EP_2022.to) {
    window2022.push({ date: d, baseRung, clampRung, failOff });
  }
}

// ---------- 4. the diff + the isolated clamp-effect diagnostic ----------
const diffRows = window2022.filter((r) => r.baseRung !== r.clampRung);
const clampHits2022 = clampHits.filter((h) => h.episode === EP_2022.name);
const clampHitsByEpisode: Record<string, number> = {};
for (const e of EPISODES) clampHitsByEpisode[e.name] = 0;
for (const h of clampHits) if (h.episode) clampHitsByEpisode[h.episode] = (clampHitsByEpisode[h.episode] ?? 0) + 1;

const snapshot = {
  probe: "W5-e Phase C — 2022 clamp on/off rung-path divergence + isolated clamp effect",
  window: { name: EP_2022.name, from: EP_2022.from, to: EP_2022.to },
  generatedFrom: {
    acwiFixture: ACWI_FIXTURE,
    acwiCloses: acwiObs.length,
    failOffTrueCloses, // join liveness: how many closes had the gate ON at all
    biteDefinition: "failOff===true && prevRung>0 && |candidateRung−prevRung|>1 (bidirectional, §9)",
    note:
      "ISOLATED clamp effect = closes where decideRotationHold's committed sleeve differs between gate OFF and " +
      "gate=failOff on the SAME carried state (history held equal). This is the TRUE behaviour change; " +
      "the A-2 'bite' count is on the dial's REQUESTED move (pre-M8), so it OVERSTATES the clamp when M8 " +
      "already holds the re-risk. Path divergence = the two independently-folded arms compared.",
  },
  // Isolated effect (the honest behaviour-change measure).
  clampBiteAll: clampHits.length, // over ALL history — does the LIVE clamp EVER change a commit?
  clampBite2022: clampHits2022.length,
  clampBiteByEpisode: clampHitsByEpisode,
  clampHits, // full detail for review (date, episode, prev/off/on rungs)
  // Path divergence over the 2022 window.
  window2022Closes: window2022.length,
  diffCloses: diffRows.length,
  diff: diffRows,
};
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");

// ---------- 5. report ----------
console.log(`W5-e Phase C — 2022 clamp on/off divergence probe — env=local`);
console.log(`acwi axis: ${acwiObs.length} closes; 2022 window: ${window2022.length} closes`);
console.log(`failOff ON (gate would fire) on ${failOffTrueCloses} closes over all history (join liveness).`);
console.log("");
console.log(
  `ISOLATED clamp effect (history held equal): ${clampHits.length} close(s) over all history change ` +
    `the committed sleeve when the gate is on; ${clampHits2022.length} within 2022.`,
);
console.log(`  by episode: ${JSON.stringify(clampHitsByEpisode)}`);
if (clampHits.length > 0) {
  console.log("\n  first 12 isolated clamp hits (date  episode  prev→off/on rung  failOff):");
  for (const h of clampHits.slice(0, 12)) {
    console.log(`    ${h.date}  ${h.episode ?? "—"}  prev=${h.prevRung} off=${h.offRung} on=${h.onRung}  failOff=${h.failOff}`);
  }
}
console.log("");
console.log(
  diffRows.length > 0
    ? `PATH DIVERGES: ${diffRows.length}/${window2022.length} 2022 closes have baseRung != clampRung (compounded).`
    : `PATH IDENTICAL: the two independently-folded 2022 rung paths match (no compounded divergence).`,
);
console.log(`\nwrote snapshot → ${SNAPSHOT_PATH}`);
