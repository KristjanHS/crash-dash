/** probe:sn-mass — an acceptance instrument.
 *
 *  Replays prod READ-ONLY (`getSeries` only, no writes) through the SHIPPED `computeField` and prints,
 *  per leg: the STRESS-NOW pillar, `ciss` vs the `J` (C=J degrade) form, `active`, `depth`, and every
 *  SN cell's `cellState` / sensitivity kind / `wsev` / declared family weight.
 *
 *  It exists because the mass inversion was invisible to every unit test: no test pins an SN pillar's
 *  VALUE, so the defect could only be seen by replaying the real close. Read the pillar column, not the
 *  cells — the cells were never wrong, the DENOMINATOR was (`cissForm` normalises `w[i]/Σw` over the
 *  leg's live cells only, so a low-weight measured cell INFLATES the pillar it dilutes).
 *
 *  Acceptance: Health and Staples both below Semis on SN,
 *  no `estimated` cell in either leg's SN group, and `active: true` (not the C=J degrade) for both. This
 *  script EXITS 1 when any of those fails, so it is a falsifier, not a report — see `assertAcceptance` below.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { LEG_FIELD, SUPER_GROUP_OF, FAMILY_LEG_WEIGHT } from "../src/danger-ladder.js";
import { computeFamilyPanel } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import {
  computeField,
  cellSensitivity,
  superGroupDangerCissDetailed,
  superGroupDangerJ,
  CISS_WINDOW,
} from "../src/danger-engine.js";
import { buildMemberState, buildMemberStateHeld, noHoldDepth } from "../src/danger-member-state.js";
import { loadSeriesWith, unionCalendar, panelAt } from "./lib/replay-walk.js";

const store = await resolveStore("prod", liveResolveDeps);
const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeriesWith((id) => store.getSeries(id, 20000), memberIds);
const axis = unionCalendar(seriesById, memberIds);
const asOf = axis[axis.length - 1]!;
const at = panelAt(seriesById, memberIds, asOf, { historyLen: CISS_WINDOW + 30 });
const panel = computeFamilyPanel(at.readings, DIAL_FAMILIES);
const held = noHoldDepth(at.cissHistory)
  ? buildMemberState({ globalFamilies: panel.families })
  : buildMemberStateHeld({ globalFamilies: panel.families }, at.cissHistory);
const dial = computeT1Dial(
  panel.families,
  techConfirmerBreadth(techConfirmerFromPanel(panel.families, undefined, held)),
);
const field = computeField({ globalFamilies: panel.families }, dial.band, undefined, null, at.cissHistory);

const legOf = (sleeve: string) => LEG_FIELD.find((l) => l.sleeve === sleeve)!;
const num = (x: number, w = 8) => x.toFixed(4).padStart(w);

console.log(`probe:sn-mass — prod replay, asOf ${asOf}\n`);
console.log(
  "leg".padEnd(9) + "SN".padStart(8) + "J".padStart(8) + "danger".padStart(8) +
    "  active depth   STRESS-NOW cells (family kind wsev w)",
);

type Report = { leg: string; sn: number; active: boolean; estimated: string[] };
const reports: Report[] = [];

for (const r of field.legRows) {
  const leg = legOf(r.sleeve);
  const cells = r.cells as any[];
  const detail = superGroupDangerCissDetailed(cells as any, leg, "STRESS-NOW", at.cissHistory);
  const j = superGroupDangerJ(cells as any, leg, "STRESS-NOW");
  const snCells = cells.filter((c) => (SUPER_GROUP_OF as Record<string, string>)[c.family] === "STRESS-NOW");
  const estimated: string[] = [];
  const rendered = snCells.map((c) => {
    const s: any = cellSensitivity(c.family, r.sleeve);
    if (s.kind === "estimated") estimated.push(c.family);
    const w = (FAMILY_LEG_WEIGHT as any)[c.family]?.[r.sleeve];
    return `${c.family}:${c.cellState}/${s.kind}/${(c.wsev ?? 0).toFixed(3)}/${w ?? "INSENS"}`;
  });
  console.log(
    r.sleeve.padEnd(9) + num(detail.value) + num(j.value) + num(r.danger) +
      `  ${String(detail.active).padEnd(6)} ${String(detail.depth).padStart(5)}   ` + rendered.join("  "),
  );
  reports.push({ leg: r.sleeve, sn: detail.value, active: detail.active, estimated });
}

/** The acceptance gate, as a FALSIFIER. Each
 *  clause can genuinely fail: before the S2 seat, clause 1 failed (Health .3234 > Semis .1975) and
 *  clause 2 failed (two estimated cells). */
function assertAcceptance(rows: Report[]): string[] {
  const fail: string[] = [];
  const by = (n: string) => rows.find((r) => r.leg === n)!;
  const semis = by("Semis").sn;
  for (const n of ["Health", "Staples"]) {
    const r = by(n);
    if (!(r.sn < semis)) fail.push(`${n} SN ${r.sn.toFixed(4)} is not below Semis ${semis.toFixed(4)}`);
    if (r.estimated.length > 0) fail.push(`${n} still carries estimated SN cell(s): ${r.estimated.join(",")}`);
    if (!r.active) fail.push(`${n} SN pillar is not active (C=J degrade)`);
  }
  return fail;
}

const failures = assertAcceptance(reports);
console.log();
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL — ${f}`);
  console.log(`\nVERDICT: FAIL — ${failures.length} acceptance clause(s) unmet.`);
  process.exit(1);
}
console.log("VERDICT: PASS — Health/Staples below Semis on SN, no estimated SN cell, both pillars active.");
