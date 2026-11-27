/**
 * probe-absence-field.ts — OQ-5 Stage 5.2 §7 MEASUREMENT: the 9-leg before/after danger table
 * over `LADDER`, off a real-close replay, with the pre-absence-field calm-imputing arm reconstructed
 * IN-PROBE.
 *
 *   scripts/db.sh with dev -- npx tsx scripts/probe-absence-field.ts
 *
 * WHY IT EXISTS. Stage 5.2
 * made an ABSENT family member leave the `wsev` max instead of being imputed `calm`. The
 * standing normalization-change duty (carried since 2026-08-08 by the weight-table pin in
 * `scripts/capture-core9-baseline.test.ts`, not by a rule file) owes a 9-leg before/after
 * ordering table over `LADDER` off a real-close replay for exactly that class of change:
 *   (1) NORMAL conditions (no member absent)   — expected IDENTICAL;
 *   (2) an INJECTED-ABSENCE scenario           — the table must MOVE vs (1), or the probe is blind.
 *
 * THE CONTROL ARM (the "before" arm no longer exists in the tree). Before the absence-field change the engine read
 * every member as `memberState[m] ?? "calm"` at six sites (`computeCells` states + max,
 * `familyWorstState`, `familyWsev`, the then-live `exogenousFloor` (DELETED 2026-08-02 by C1 —
 * named here as HISTORY, describing the pre-change tree, not the current one), `trendConfirming`).
 * Every one of those sites
 * is a plain lookup with a calm DEFAULT, so the old semantics is reproduced EXACTLY by making the
 * map TOTAL over the census: feed the panel an extra `GREEN` reading for every census member the
 * real panel does not carry. Then no `??` can ever fire, and the (unmodified, shipped) engine
 * executes the old code path value-for-value. `severityOf("GREEN") === "calm"` is the same mapping
 * the old code defaulted to, and the `obs` axis added in 5.2 does not enter any severity max (S-2:
 * fresh and stale both count), so the imputed member's `obs: "lag"` is severity-neutral.
 * `check 1` PROVES the totality precondition at run time instead of asserting it in prose.
 *
 * Deliberately NOT done: front-padding the `cissHistory` windows to reproduce
 * `buildMemberStateAt`'s old "too-short history ⇒ calm" imputation. Padding would lengthen the
 * series, and history LENGTH feeds the engine's depth reads — the control arm would then differ
 * from the old code in its degrade decisions, which is a WORSE infidelity than the one it repairs. The historical path is inert for the same algebraic reason as the live one (see
 * check 3), and both arms are fed the SAME unmodified histories.
 *
 * ARMS: LIVE vs CONTROL under three scenarios —
 *   NORMAL   the real panel;
 *   ABSENCE  the real panel minus the top real severity contributor (DERIVED, never hand-typed);
 *   PLACEBO  the highest-REACH currently-GREEN member forced RED — the SENSITIVITY control. If the
 *            placebo does not move the table, the comparator is blind and every "identical" verdict
 *            here is vacuous, so that check FAILS the probe. It must be a GREEN member: the absence
 *            victim is by construction the worst-severity one, so "force IT red" is often a no-op.
 *
 * SENSITIVITY CAVEAT, measured (red demo, densify-with-RED): at an anchor where the only unobserved
 * census members carry ZERO reach on every measured cell, check (1) cannot fail whatever the control
 * arm imputes. That is the LATEST anchor today (5 imputed: T10YIE, T5YIFR, SPCONC, OVX, BRENT). The
 * STRESS anchor (11 imputed, incl. F1/F10) IS sensitive and went red under that mutation — which
 * is why this probe runs two anchors and not just the latest close.
 *
 * DATA PATH: the persisted dev store (the same reconstruction `probe-drawdown-bite.ts` uses), at
 * two anchors — the latest close and the most-stressed historical close (max RED count, DERIVED).
 * `scripts/backtest/replay.ts` `buildSeries()` CANNOT serve this measurement: it wires 10 ids, of
 * which 9 are dial members, so 26 of the 35 `DIAL_FAMILIES` members would be ABSENT by fixture
 * poverty — an offline "normal conditions" arm would be an absence scenario in disguise.
 *
 * ⚠ STRICTLY READ-ONLY: `getSeries` selects only.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { computeFamilyPanel, LADDER } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import {
  computeField,
  legRAG,
  memberWeight,
  pillarValue,
  type MemberHistoryEntry,
  type LegRow,
} from "../src/danger-engine.js";
import { buildMemberState } from "../src/danger-member-state.js";
import { SIGNALS, FAMILY_MEMBERS } from "../src/danger-ladder.js";
import type { State } from "../src/domain-types.js";
import { loadSeriesWith, unionCalendar, panelAt as panelAtSeam, MEMBER_WINDOW } from "./lib/replay-walk.js";

/** Mirrors `dial-assembly.ts`'s private `MEMBER_HISTORY_PAD` (=30), as `probe-drawdown-bite.ts` does. */
const MEMBER_HISTORY_PAD = 30;
const FETCH_LIMIT = 20_000;
/** Danger equality tolerance — pure float noise only; the arms are expected bit-for-bit equal. */
const EPS = 1e-12;

type Reading = { id: string; state: State };

// ---------- store + panel reconstruction (pattern: probe-drawdown-bite.ts §2) ----------
let store;
try {
  store = await resolveStore("local", "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no local store reachable — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The dev stack defaults DOWN — re-run under the front door:\n` +
      `      scripts/db.sh with dev -- npx tsx scripts/probe-absence-field.ts`,
  );
  process.exit(1);
}

const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeriesWith((id) => store.getSeries(id, FETCH_LIMIT), memberIds);

const axis = unionCalendar(seriesById, memberIds);
if (axis.length === 0) {
  console.log("ABORT: the store returned zero closes for every dial member — nothing to replay.");
  process.exit(1);
}

// SEAM (Stage 3.B-2): `walkReplay`'s fold does NOT apply here — this probe has no calendar walk; it
// evaluates at two fixed anchors and inspects. Only the panel assembly is shared, via `panelAt`.
/** Members present at `d` under the shipped forward-fill horizon, with their history slice. Each call
 *  builds its own cursor (the lib default), because the anchors are not visited in ascending order.
 *  NOT the dominant cost — that is `redCountAt`'s ascending scan over the whole axis below, which
 *  COULD safely share one cursor; it is the two out-of-order ANCHOR calls that force the fresh scan
 *  here. A perf pass wanting the shared cursor must split those two callers, not relax this. */
const panelAt = (d: string): { readings: Reading[]; cissHistory: MemberHistoryEntry[] } =>
  panelAtSeam(seriesById, memberIds, d, { historyLen: MEMBER_WINDOW + MEMBER_HISTORY_PAD });

// ---------- the census the control arm must be TOTAL over ----------
const census = [...new Set(SIGNALS.flatMap((f) => [...FAMILY_MEMBERS[f]]))];

// ---------- the table ----------
interface Row {
  sleeve: string;
  danger: number;
  ew: number | null;
  sn: number | null;
  rag: State;
  absent: number; // Σ over the leg's cells of `observed.absent` — the new 5.2 census
}
const rowOf = (r: LegRow): Row => ({
  sleeve: r.sleeve,
  danger: r.danger,
  ew: pillarValue(r.subDangers.earlyWarn),
  sn: pillarValue(r.subDangers.stressNow),
  rag: legRAG(r.cells),
  absent: r.cells.reduce((a, c) => a + c.observed.absent, 0),
});

/** LIVE arm: the shipped engine over the real panel. */
function liveArm(readings: Reading[], cissHistory: MemberHistoryEntry[]): Row[] {
  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const dial = computeT1Dial(panel.families, techConfirmerBreadth(techConfirmerFromPanel(panel.families)));
  return computeField({ globalFamilies: panel.families }, dial.band, undefined, null, cissHistory)
    .legRows.map(rowOf);
}

/** CONTROL arm: the pre-absence-field calm imputation, reconstructed by DENSIFYING the panel (see the
 *  docblock). The band is taken from the LIVE panel of the SAME scenario and held fixed, so the two
 *  arms are compared at one band — the band is not what 5.2 changed. */
function controlArm(readings: Reading[], cissHistory: MemberHistoryEntry[]): Row[] {
  const have = new Set(readings.map((r) => r.id));
  const dense: Reading[] = [
    ...readings,
    ...census.filter((id) => !have.has(id)).map((id) => ({ id, state: "GREEN" as State })),
  ];
  const livePanel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const dial = computeT1Dial(livePanel.families, techConfirmerBreadth(techConfirmerFromPanel(livePanel.families)));
  const panel = computeFamilyPanel(dense, DIAL_FAMILIES);
  return computeField({ globalFamilies: panel.families }, dial.band, undefined, null, cissHistory)
    .legRows.map(rowOf);
}

const SEV_OF: Record<State, number> = { GREEN: 0, AMBER: 0.5, RED: 1 };
/** The single member whose real severity reaches the most weight across the 9 legs — DERIVED, so a
 *  weight/roster change cannot leave this probe injecting an id that no longer bites. */
function topContributor(readings: Reading[]): Reading | null {
  const scored = readings
    .filter((r) => SEV_OF[r.state] > 0 && census.includes(r.id))
    .map((r) => ({ r, w: LADDER.reduce((a, s) => a + memberWeight(r.id, s) * SEV_OF[r.state], 0) }))
    .sort((a, b) => b.w - a.w);
  return scored[0] && scored[0].w > 0 ? scored[0].r : null;
}

/** The highest-REACH currently-GREEN member — the placebo's subject. It must be GREEN: the absence
 *  victim is by construction the worst-severity member, so "force IT red" is frequently a no-op and
 *  would make the sensitivity control itself vacuous (observed: it silently did, first run). */
function topCalmReach(readings: Reading[]): Reading | null {
  const scored = readings
    .filter((r) => r.state === "GREEN" && census.includes(r.id))
    .map((r) => ({ r, w: LADDER.reduce((a, s) => a + memberWeight(r.id, s), 0) }))
    .sort((a, b) => b.w - a.w);
  return scored[0] && scored[0].w > 0 ? scored[0].r : null;
}

const sameRow = (a: Row, b: Row) =>
  Math.abs(a.danger - b.danger) <= EPS &&
  (a.ew === null ? b.ew === null : b.ew !== null && Math.abs(a.ew - b.ew) <= EPS) &&
  (a.sn === null ? b.sn === null : b.sn !== null && Math.abs(a.sn - b.sn) <= EPS) &&
  a.rag === b.rag;
const sameTable = (a: Row[], b: Row[]) => a.length === b.length && a.every((r, i) => sameRow(r, b[i]!));

const f3 = (n: number | null) => (n === null ? "  na " : n.toFixed(3).padStart(5));
function printTable(title: string, live: Row[], control: Row[]): void {
  console.log(`\n  ${title}`);
  console.log("  leg       | LIVE danger  EW    SN   RAG abs | CONTROL danger  EW    SN   RAG abs | Δdanger");
  for (let i = 0; i < live.length; i++) {
    const l = live[i]!;
    const c = control[i]!;
    console.log(
      `  ${l.sleeve.padEnd(9)} |       ${f3(l.danger)} ${f3(l.ew)} ${f3(l.sn)} ${l.rag.padEnd(5)}` +
        `${String(l.absent).padStart(2)} |          ${f3(c.danger)} ${f3(c.ew)} ${f3(c.sn)} ${c.rag.padEnd(5)}` +
        `${String(c.absent).padStart(2)} | ${(l.danger - c.danger).toFixed(12)}`,
    );
  }
}

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok = ok && pass;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- anchors: the latest close + the most-stressed historical close (DERIVED) ----------
const redCountAt = (d: string) => panelAt(d).readings.filter((r) => r.state === "RED").length;
let stress = { date: axis[0]!, reds: -1 };
for (const d of axis) {
  const n = redCountAt(d);
  if (n >= stress.reds) stress = { date: d, reds: n }; // ties → the LATEST such close
}
const anchors = [
  { label: `LATEST close ${axis[axis.length - 1]}`, date: axis[axis.length - 1]!, requireMove: false },
  { label: `STRESS close ${stress.date} (${stress.reds} RED members — max over the axis)`, date: stress.date, requireMove: true },
];

console.log(
  `[probe-absence-field] OQ-5 Stage 5.2 §7 — 9-leg danger table, LIVE (absent excluded) vs CONTROL ` +
    `(pre-absence-field calm imputation)\n  DATA PATH: dev store, ${axis.length} closes ` +
    `${axis[0]} .. ${axis[axis.length - 1]}, ${memberIds.length} dial members, census ${census.length}`,
);

for (const anchor of anchors) {
  const { readings, cissHistory } = panelAt(anchor.date);
  const observed = new Set(readings.map((r) => r.id));
  const missing = census.filter((id) => !observed.has(id));

  console.log(`\n══ ${anchor.label} — ${readings.length}/${memberIds.length} members present ══`);

  // check 1 — the control arm's fidelity precondition, MEASURED: its member map is total over the
  // census (so no `?? "calm"` site could fire in the old code) and agrees with the live map wherever
  // the live map has a key (so densification only ADDS the imputed calms, never rewrites a reading).
  const denseHave = new Set(readings.map((r) => r.id));
  const densePanel = computeFamilyPanel(
    [...readings, ...census.filter((id) => !denseHave.has(id)).map((id) => ({ id, state: "GREEN" as State }))],
    DIAL_FAMILIES,
  );
  const ctlMap = buildMemberState({ globalFamilies: densePanel.families });
  const liveMap = buildMemberState({ globalFamilies: computeFamilyPanel(readings, DIAL_FAMILIES).families });
  const notTotal = census.filter((id) => ctlMap[id] === undefined);
  const disagree = Object.keys(liveMap).filter((id) => liveMap[id]!.sev !== ctlMap[id]?.sev);
  check(
    "control arm is TOTAL over the census and agrees with the live map on every observed member",
    notTotal.length === 0 && disagree.length === 0,
    `not-total [${notTotal.join(",")}] · disagreeing [${disagree.join(",")}] · imputed-calm ${missing.length}` +
      (missing.length ? ` [${missing.join(",")}]` : ""),
  );

  // ---- scenario 1: NORMAL ----
  const nLive = liveArm(readings, cissHistory);
  const nCtl = controlArm(readings, cissHistory);
  printTable("(1) NORMAL conditions", nLive, nCtl);
  check("(1) NORMAL: LIVE table ≡ CONTROL table over all 9 legs", sameTable(nLive, nCtl));

  // ---- scenario 2: INJECTED ABSENCE ----
  const victim = topContributor(readings);
  if (victim === null) {
    check("(2) an injectable non-calm member exists at this anchor", !anchor.requireMove,
      "every observed member is GREEN — no absence can move a max over non-negatives");
    continue;
  }
  const dropped = readings.filter((r) => r.id !== victim.id);
  const droppedHist = cissHistory.filter((h) => h.id !== victim.id);
  const aLive = liveArm(dropped, droppedHist);
  const aCtl = controlArm(dropped, droppedHist);
  printTable(`(2) INJECTED ABSENCE — ${victim.id} (${victim.state}) dropped from the panel`, aLive, aCtl);
  check("(2) ABSENCE: LIVE table ≡ CONTROL table over all 9 legs", sameTable(aLive, aCtl));

  // NON-VACUITY: the injection must actually reach the danger layer, i.e. the absence table must be
  // a DIFFERENT table from the normal one. Without this the two "identical" verdicts above could be
  // satisfied by an injection the engine never saw.
  const moved = nLive.filter((r, i) => !sameRow(r, aLive[i]!)).map((r) => r.sleeve);
  const absentRose = aLive.reduce((a, r) => a + r.absent, 0) - nLive.reduce((a, r) => a + r.absent, 0);
  check(
    `(2) NON-VACUITY: the injected absence MOVES the 9-leg table vs (1)`,
    !anchor.requireMove || moved.length > 0,
    `legs moved [${moved.join(",") || "none"}] · Σabsent +${absentRose}`,
  );

  // ALGEBRA (today's held semantics, §5.2 item 5): at the danger layer an ABSENT member reads
  // exactly like an OBSERVED-CALM one, because 0 is the identity of a max over non-negatives and
  // the fully-unobserved cell is held at 0 until Stage 5.3. Stated as a check so that a future 5.3
  // change to `observedWeightedMax`'s empty case turns this line RED instead of passing silently.
  const asCalm = readings.map((r) => (r.id === victim.id ? { ...r, state: "GREEN" as State } : r));
  const cLive = liveArm(asCalm, cissHistory);
  check(
    `ALGEBRA: dropping ${victim.id} ≡ observing it GREEN, at the danger layer (Stage 5.3 gate)`,
    sameTable(aLive, cLive),
  );

  // ---- scenario 3: PLACEBO (sensitivity control) ----
  const subject = topCalmReach(readings);
  const flipped = readings.map((r) => (r.id === subject?.id ? { ...r, state: "RED" as State } : r));
  const pLive = subject ? liveArm(flipped, cissHistory) : nLive;
  const pMoved = nLive.filter((r, i) => !sameRow(r, pLive[i]!)).map((r) => r.sleeve);
  check(
    `(3) PLACEBO: forcing ${subject?.id ?? "(none)"} GREEN→RED moves the table (comparator is NOT blind)`,
    subject !== null && pMoved.length > 0,
    `legs moved [${pMoved.join(",") || "none"}]`,
  );
}

console.log(`\n[probe-absence-field] ${ok ? "ALL CHECKS PASS" : "CHECKS FAILED"}`);
process.exit(ok ? 0 : 1);
