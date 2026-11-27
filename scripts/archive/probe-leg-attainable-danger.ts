/**
 * probe-leg-attainable-danger.ts — the CEILING each leg can reach, not the one it did. OFFLINE.
 *
 * QUANTITY MEASURED: `computeField(...).legRows[].danger` on a SYNTHETIC close where every member
 * of every family is forced to a single state, swept GREEN → AMBER → RED. The RED row is each leg's
 * MAX ATTAINABLE danger: the largest number that leg's weight tables physically allow, with the
 * whole world on fire. Compared against the live `DANGER_CUTS` (READ, never restated).
 *
 * WHY: an earlier audit measured Health/Staples peaking at 0.2347/0.2412
 * over 900 prod closes and asked whether that is (i) a structural cap — their `MEMBER_WEIGHT` rows top
 * out near 0.5-0.6 where Semis/EM reach 1.0, so the weighted-max pillar cannot climb — or (ii) an
 * honest read of two genuinely quiet defensive sectors. Those need OPPOSITE fixes, and only the
 * attainable ceiling separates them. A leg whose attainable max sits BELOW `DANGER_CUTS.amber` is
 * structurally mute: no market state can colour it, which is a defect in the table, not a signal.
 *
 * ⚠ THE CEILING IS HISTORY-SHAPED, so this sweeps SHAPES and reports the max over them. A flat
 * all-RED history collapses the CISS pillar (it needs VARIETY, not depth) — that artifact once
 * printed Health/Staples at 0.1140 and called them structurally mute.
 *
 * NO DATABASE. Pure table arithmetic through the shipped engine — no store, no network, no env.
 *
 * Usage:  npx tsx scripts/probe-leg-attainable-danger.ts
 */
import { US_FAMILIES, GLOBAL_FAMILIES, computeFamilyPanel } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth } from "../src/t1dial.js";
import { computeField, pillarValue, type MemberHistoryEntry } from "../src/danger-engine.js";
import { DANGER_CUTS, CISS_WINDOW } from "../src/danger-concentration.js";
import { MEMBER_WEIGHT, LEG_FIELD } from "../src/danger-ladder.js";
import { DOWNSIDE_DETECTOR_IDS } from "../src/indicators.js";
import type { State } from "../src/domain.js";

const memberIds = [...new Set([...US_FAMILIES, ...GLOBAL_FAMILIES].flatMap((f) => f.ids))];
const HIST_TAIL = CISS_WINDOW + 8;

/** History shapes to sweep. A leg's attainable danger depends on the PATH, not just today's state. */
const SHAPES: Record<string, (k: number, tail: number) => State> = {
  flat: () => "RED",
  cycle3: (k) => (k % 3 === 0 ? "GREEN" : k % 3 === 1 ? "AMBER" : "RED"),
  calmThenRed: (k, t) => (k < t - 6 ? "GREEN" : "RED"),
  alternateGR: (k) => (k % 2 ? "GREEN" : "RED"),
  alternateAR: (k) => (k % 2 ? "AMBER" : "RED"),
  rampGAR: (k, t) => (k < t / 3 ? "GREEN" : k < (2 * t) / 3 ? "AMBER" : "RED"),
};

/** Severity order, so a swept history can be CAPPED at the row's own state — the AMBER row must not
 *  borrow RED history, or every column collapses onto the ceiling. */
const RANK: Record<State, number> = { GREEN: 0, AMBER: 1, RED: 2 };

/** One synthetic close: every member reads `state` today, over a history drawn by `shape` and capped
 *  at `state`, so each row answers "the worst this leg reaches with nothing above `state` ever seen". */
function fieldAt(state: State, shape: (k: number, tail: number) => State) {
  const at = (k: number): State => {
    const v = shape(k, HIST_TAIL);
    return RANK[v] > RANK[state] ? state : v;
  };
  const readings = memberIds.map((id) => ({ id, state }));
  const history: MemberHistoryEntry[] = memberIds.map((id) => ({
    id,
    history: Array.from({ length: HIST_TAIL }, (_, k) => ({
      date: `2000-01-${String((k % 28) + 1).padStart(2, "0")}`,
      value: 0,
      state: at(k),
      rawState: at(k),
      delta20: 0,
    })),
  }));
  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const dial = computeT1Dial(panel.families, techConfirmerBreadth(DOWNSIDE_DETECTOR_IDS.map(() => state)));
  const globalPanel = computeFamilyPanel(readings, GLOBAL_FAMILIES);
  return computeField(
    { globalFamilies: globalPanel.families },
    dial.band,
    undefined,
    null,
    history,
    undefined,
    undefined,
    undefined,
    undefined,
    dial.targetRung,
  );
}

type Cell = { danger: number; ew: number | null; sn: number | null; shape: string };
const STATES: State[] = ["GREEN", "AMBER", "RED"];
const rows = new Map<State, Map<string, Cell>>();
for (const st of STATES) {
  const best = new Map<string, Cell>();
  for (const [shape, fn] of Object.entries(SHAPES)) {
    for (const r of fieldAt(st, fn).legRows) {
      const cur = best.get(r.sleeve);
      if (cur && cur.danger >= r.danger) continue;
      best.set(r.sleeve, {
        danger: r.danger,
        ew: pillarValue(r.subDangers.earlyWarn),
        sn: pillarValue(r.subDangers.stressNow),
        shape,
      });
    }
  }
  rows.set(st, best);
}

/** Largest weight any table row assigns this leg — the pillar's arithmetic ceiling before folding. */
const maxRowWeight = (leg: string): number =>
  Math.max(0, ...Object.values(MEMBER_WEIGHT).map((row) => (row as Record<string, number>)[leg] ?? 0));

const legs = LEG_FIELD.map((l) => l.sleeve);
const fmt = (n: number | null): string => (n == null ? "  —   " : n.toFixed(4));

console.log(`\n-- Max ATTAINABLE danger per leg (every member forced to one state) --`);
console.log(`   cuts READ from DANGER_CUTS: amber=${DANGER_CUTS.amber}  red=${DANGER_CUTS.red}`);
console.log(`   ceiling = MAX over ${Object.keys(SHAPES).length} history shapes: ${Object.keys(SHAPES).join(", ")}`);
console.log(`\n   leg        maxWt   GREEN    AMBER    RED(=ceiling)  ew@RED   sn@RED   shape         verdict`);
let mute = 0;
for (const leg of legs) {
  const red = rows.get("RED")!.get(leg);
  if (!red) continue;
  const ceil = red.danger;
  const verdict =
    ceil < DANGER_CUTS.amber
      ? "STRUCTURALLY MUTE (cannot reach amber)"
      : ceil < DANGER_CUTS.red
        ? "amber-capable, RED UNREACHABLE"
        : "can reach red";
  if (ceil < DANGER_CUTS.amber) mute++;
  console.log(
    `   ${leg.padEnd(8)}  ${maxRowWeight(leg).toFixed(2)}   ` +
      `${fmt(rows.get("GREEN")!.get(leg)!.danger)}  ${fmt(rows.get("AMBER")!.get(leg)!.danger)}  ` +
      `${fmt(ceil)}         ${fmt(red.ew)}  ${fmt(red.sn)}   ${red.shape.padEnd(12)}  ${verdict}`,
  );
}
console.log(`\n   ${mute} leg(s) cannot reach DANGER_CUTS.amber under ANY market state.`);
