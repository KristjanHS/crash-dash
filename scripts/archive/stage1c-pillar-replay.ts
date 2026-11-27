/**
 * Stage-1c evidence replay — READ-ONLY.
 *
 * Replays the per-leg danger field over the last N closes from the store and reports:
 *  A. pillar distributions: static p=2 power-mean vs raw-CISS quadratic form,
 *     + share of leg-closes where the CISS path was active vs degraded-to-static
 *  B. percentile-mapped DANGER_CUTS amber/red candidates (old-static percentile of
 *     0.25/0.75 mapped onto the CISS-active distribution) + the naive square-map
 *     (0.0625/0.5625) + regime-quadrant flip counts per amber candidate vs today
 *  C. held-pick churn: OLD combine (p=2 power-mean base + VETO cap 0.5, the
 *     pre-worst-of engine (before the worst-of commit), reimplemented inline) vs NEW worst-of+CISS
 *
 * Part D (the F12/mc depth-gate arm: EW degrade fraction on mc-reached legs with vs without F12
 * bounding the CISS depth) was DELETED 2026-07-17 with F12 itself (DEC-21, dead-feed retirement).
 * Its premise is gone twice over: F12 no longer exists to exclude, and `mc` is memberless, so
 * "mc-reached legs" is the empty set. Its finding is already banked in the per-family depth gate
 * that shipped from it (`superGroupDangerCissDetailed`, danger-engine.ts).
 *
 * STRICTLY READ-ONLY: getSeries selects only — never insert/update/delete/upsert.
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env.local scripts/backtest/stage1c-pillar-replay.ts [--closes=365] [--env=local|prod]
 * Store resolution mirrors scripts/backfill (resolve-store.ts): SUPABASE_URL+KEY in
 * env → that store; else --env=prod pulls prod creds via the Management API (host).
 */
import { resolveStore, liveResolveDeps } from "../backfill/resolve-store.js";
import { US_FAMILIES, GLOBAL_FAMILIES, LADDER, computeFamilyPanel } from "../../src/families.js";
import { computeT1Dial, techConfirmerBreadth } from "../../src/t1dial.js";
import { DIAL_FAMILIES } from "../../src/dial-assembly.js";
import {
  computeCells,
  computeDanger,
  superGroupDanger,
  superGroupDangerCissDetailed,
  CISS_WINDOW,
  DANGER_CUTS,
  CONC_THRESHOLD,
  CONC_WEIGHT,
  DERISK_DEADBAND,
  RERISK_DEADBAND,
  type MemberHistoryEntry,
} from "../../src/danger-engine.js";
import { buildMemberState } from "../../src/danger-member-state.js";
import {
  LEG_FIELD, 
  CLUSTERS,
  type SuperGroup,
} from "../../src/danger-ladder.js";
import { DOWNSIDE_DETECTOR_IDS } from "../../src/registry-price.js";
import type { State } from "../../src/domain-types.js";
import { argOf, envArg as envArgOf } from "../lib/cli.js";
import { loadSeries, calendarFrom, makeCursor, selectReplayDates } from "../lib/replay-walk.js";

// ---------- args ----------
const REPLAY_N = Number(argOf("closes") ?? 365);
const envArg = envArgOf("prod");

const store = await resolveStore(envArg, liveResolveDeps);

// ---------- data pull (read-only) ----------
const memberIds = [...new Set([...US_FAMILIES, ...GLOBAL_FAMILIES].flatMap((f) => f.ids))];
// tech-confirmer inputs; order (SMH, XLK) mirrors DOWNSIDE_DETECTORS (registry source), no consumer here depends on it
const DB_IDS = DOWNSIDE_DETECTOR_IDS;
// `loadSeries` replaces a `.catch(() => [])` (carriers round, 2026-08-02): a silently-empty member is
// absent for EVERY date, drops its family out of `computeFamilyPanel`'s worst-of and moves the pillar
// distributions this replay reports. Read-only, so the ABORT is pure upside.
const seriesById = await loadSeries(store, [...memberIds, ...DB_IDS], REPLAY_N + CISS_WINDOW + 200);

// Calendar = F4 daily closes (deep trading-day cadence); earlier closes are CISS pre-history.
// `calendarFrom`'s default axis IS "F4" (`DEFAULT_AXIS_ID`), so this is the previous expression exactly.
// SEAM (carriers round): `unionCalendar` DECLINED — the trading-day axis is the point, not every date
// on which anything moved.
const calendar = calendarFrom(seriesById);
// `selectReplayDates` is an exact match here: its `margin` defaults to `CALENDAR_MARGIN` = 30, the
// literal this guard carried, and with no `--from`/`--to` its other two aborts are unreachable. The
// ABORT WORDING changes — `lib/` unified on the variant that also prints the achievable max `--closes`.
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N });

// per-member pointer walk: latest point index with date <= d (calendar is monotonic)
const advance = makeCursor(seriesById);

// ---------- gate diagnostics come straight from the engine ----------
// `superGroupDangerCissDetailed` (src/danger-engine.ts) IS the live pillar path plus the active/depth
// instrumentation this replay reports on — no mirrored gate here (it drifted once; never again).
type Pillar = { value: number; live: boolean };
/** OLD (pre-worst-of) combine: p=2 power-mean base + veto cap at 0.5 — reimplemented
 *  inline per plan instruction (never checked out). */
const VETO_CAP_THRESHOLD = 0.5;
function oldCombine(ew: Pillar, sn: Pillar): number {
  const base = computeDanger([ew.live ? ew.value : null, sn.live ? sn.value : null], [1, 1]);
  const ewCap = ew.live && ew.value >= VETO_CAP_THRESHOLD ? ew.value : 0;
  const snCap = sn.live && sn.value >= VETO_CAP_THRESHOLD ? sn.value : 0;
  return Math.max(base, ewCap, snCap);
}
type Q = "calm" | "deter" | "stress" | "recov";
function quantAt(ew: Pillar, sn: Pillar, amber: number): Q {
  const eh = ew.live && ew.value >= amber;
  const sh = sn.live && sn.value >= amber;
  return eh && sh ? "stress" : eh ? "deter" : sh ? "recov" : "calm";
}
/** computeField's concentration + directional-deadband held pick, over an injected scalar map. */
function heldPick(
  own: Map<string, number>, band: { lo: number; hi: number }, prevTarget: number | null,
  targetRung: number,
): string | null {
  const eff = new Map<string, number>();
  const maxSib = new Map<string, number>();
  for (const cluster of CLUSTERS)
    for (const s of cluster)
      maxSib.set(s, Math.max(0, ...cluster.filter((x) => x !== s).map((x) => own.get(x) ?? 0)));
  for (const l of LEG_FIELD) {
    const o = own.get(l.sleeve)!;
    const sib = maxSib.get(l.sleeve);
    eff.set(l.sleeve, sib !== undefined && sib >= CONC_THRESHOLD ? Math.max(o, CONC_WEIGHT * sib) : o);
  }
  const rising = prevTarget == null ? true : targetRung > prevTarget;
  // ⚠ `RERISK_DEADBAND` HALVED on 2026-08-07 (`DANGER_CUTS.amber` → `DANGER_CUTS.amber / 2`).
  // This resolves the constant at RUNTIME and no golden sits
  // behind it, so nothing was re-baselined here — but any replay run after that date picks a narrower
  // FALLING/STABLE window than one run before it, and the two are NOT comparable row-for-row. Pass
  // `LEGACY_RERISK_DEADBAND` (danger-engine.ts) if an old replay has to be reproduced.
  const deadband = rising ? DERISK_DEADBAND : RERISK_DEADBAND;
  const inBand = LEG_FIELD.filter((l) => l.risk >= band.lo && l.risk <= band.hi);
  if (inBand.length === 0) return null;
  const dMin = Math.min(...inBand.map((l) => eff.get(l.sleeve)!));
  return inBand
    .filter((l) => eff.get(l.sleeve)! <= dMin + deadband)
    .reduce((m, l) => (l.risk < m.risk ? l : m)).sleeve;
}

// ---------- replay ----------
interface Sample { leg: string; sg: SuperGroup; stat: number; ciss: number; active: boolean; depth: number }
const samples: Sample[] = [];
interface CloseRec {
  d: string;
  pill: Map<string, { ew: Pillar; sn: Pillar; ewS: Pillar; snS: Pillar }>;
  band: { lo: number; hi: number };
  targetRung: number;
}
const perClose: CloseRec[] = [];
const HIST_TAIL = CISS_WINDOW + 8;

// SEAM (carriers round): `panelAt` / `ffillReadings` DECLINED — both drop a member whose forward-filled
// point is older than `FFILL_MAX_CALENDAR_DAYS`; this replay applies NO lag horizon, so adopting
// either would change which members reach `computeFamilyPanel` and move every distribution below.
// `walkReplay` follows them out (it folds over `ffillReadings`), and the round is helpers-only anyway.
// `coverageOf` / `printCoverage` DECLINED: this script prints no coverage block.
for (const d of replayDates) {
  // panel + histories as-of d (mimics api/lab.ts: history only for members present in readings)
  const readings: { id: string; state: State }[] = [];
  const history: MemberHistoryEntry[] = [];
  for (const id of memberIds) {
    const i = advance(id, d);
    if (i < 0) continue;
    const pts = seriesById.get(id)!;
    readings.push({ id, state: pts[i]!.state });
    history.push({ id, history: pts.slice(Math.max(0, i + 1 - HIST_TAIL), i + 1) });
  }
  // B-11: reduce against the DIAL table, not GLOBAL_FAMILIES. This probe walks PERSISTED rows,
  // and the display-only SLOW legs ARE persisted — folding them here would replay a
  // rung/band the live cron dial can never produce. (Display folds keep GLOBAL_FAMILIES.)
  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const st = buildMemberState({ globalFamilies: panel.families });
  // dial band (tech confirmer from persisted DB_* states) — mirrors api/lab.ts two-key band math
  const dbStates = DB_IDS.map((id) => {
    const i = advance(id, d);
    return i < 0 ? null : seriesById.get(id)![i]!.state;
  });
  const dial = computeT1Dial(panel.families, techConfirmerBreadth(dbStates));
  const band = dial.band;

  const pill: CloseRec["pill"] = new Map();
  for (const leg of LEG_FIELD) {
    const cells = computeCells(leg, st);
    const out = {} as { ew: Pillar; sn: Pillar; ewS: Pillar; snS: Pillar };
    for (const sg of ["EARLY-WARN", "STRESS-NOW"] as const) {
      const stat = superGroupDanger(cells, leg, sg);
      const g = superGroupDangerCissDetailed(cells, leg, sg, history);
      if (g.live) samples.push({ leg: leg.sleeve, sg, stat: stat.value, ciss: g.value, active: g.active, depth: g.depth });
      if (sg === "EARLY-WARN") { out.ewS = stat; out.ew = { value: g.value, live: g.live }; }
      else { out.snS = stat; out.sn = { value: g.value, live: g.live }; }
    }
    pill.set(leg.sleeve, out);
  }
  perClose.push({ d, pill, band, targetRung: dial.targetRung });
}

// ---------- report helpers ----------
const QS = [0.5, 0.75, 0.9, 0.95, 1];
const qtile = (arr: number[], q: number) => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]!;
};
/** Name collision only — NOT `lib/stats.js`'s `pctOf`. That one formats `n/d` as a percent STRING;
 *  this is the percentile RANK of `v` within `arr`, returned as a 0–1 number and fed back into `qtile`. */
const pctOf = (arr: number[], v: number) => (arr.length ? arr.filter((x) => x <= v).length / arr.length : NaN);
const fmtQ = (a: number[]) => QS.map((q) => qtile(a, q).toFixed(3)).join(" / ");

// ---------- A ----------
console.log(`\n== A. Pillar distributions (pooled over ${REPLAY_N} closes x live legs; ${replayDates[0]} → ${replayDates.at(-1)}) ==`);
for (const sg of ["EARLY-WARN", "STRESS-NOW"] as const) {
  const S = samples.filter((s) => s.sg === sg);
  const act = S.filter((s) => s.active);
  console.log(`${sg}: n(live leg-closes)=${S.length}, CISS-active=${act.length} (${((100 * act.length) / Math.max(1, S.length)).toFixed(1)}%)`);
  console.log(`  static  p50/75/90/95/max: ${fmtQ(S.map((s) => s.stat))}`);
  console.log(`  cissAll p50/75/90/95/max: ${fmtQ(S.map((s) => s.ciss))}`);
  console.log(`  cissACT p50/75/90/95/max: ${act.length ? fmtQ(act.map((s) => s.ciss)) : "(none active)"}`);
  const byLeg = new Map<string, { n: number; a: number }>();
  for (const s of S) { const e = byLeg.get(s.leg) ?? { n: 0, a: 0 }; e.n++; if (s.active) e.a++; byLeg.set(s.leg, e); }
  console.log("  active% by leg: " + [...byLeg.entries()].map(([l, e]) => `${l}:${((100 * e.a) / e.n).toFixed(0)}%`).join("  "));
}

// ---------- B ----------
console.log(`\n== B. Cut candidates ==`);
const statAll = samples.map((s) => s.stat);
const cissActAll = samples.filter((s) => s.active).map((s) => s.ciss);
// The percentile-map reference is the RETIRED static-scale cuts (0.25/0.75) — pinned, not
// DANGER_CUTS, which since the 2026-07-15 FINAL ruling holds the CISS-scale result of this very
// mapping (mapping from it again would compound). Flip counts below still baseline on live cuts.
const OLD_STATIC_CUTS = { amber: 0.25, red: 0.75 } as const;
const pA = pctOf(statAll, OLD_STATIC_CUTS.amber);
const pR = pctOf(statAll, OLD_STATIC_CUTS.red);
const ambMap = qtile(cissActAll, pA);
const redMap = qtile(cissActAll, pR);
console.log(`static pooled (n=${statAll.length}): pct(amber 0.25)=${(100 * pA).toFixed(2)}%  pct(red 0.75)=${(100 * pR).toFixed(2)}%`);
console.log(`CISS-active pooled (n=${cissActAll.length}): percentile-mapped amber=${ambMap.toFixed(4)}  red=${redMap.toFixed(4)}`);
console.log(`naive square-map: amber=0.0625  red=0.5625`);
// Per-pillar mapping — a degraded pillar keeps STATIC-scale values, so pooled mapping mixes scales:
for (const sg of ["EARLY-WARN", "STRESS-NOW"] as const) {
  const S = samples.filter((s) => s.sg === sg);
  const act = S.filter((s) => s.active).map((s) => s.ciss);
  const st = S.map((s) => s.stat);
  if (act.length === 0) { console.log(`  ${sg}: no CISS-active samples — per-pillar mapping n/a`); continue; }
  console.log(
    `  ${sg}: pct(0.25)=${(100 * pctOf(st, 0.25)).toFixed(1)}% pct(0.75)=${(100 * pctOf(st, 0.75)).toFixed(1)}%` +
    ` → mapped amber=${qtile(act, pctOf(st, 0.25)).toFixed(4)} red=${qtile(act, pctOf(st, 0.75)).toFixed(4)}`,
  );
}
function flipCount(amber: number): number {
  let flips = 0;
  for (const pc of perClose)
    for (const leg of LEG_FIELD) {
      const p = pc.pill.get(leg.sleeve)!;
      if (quantAt(p.ew, p.sn, DANGER_CUTS.amber) !== quantAt(p.ew, p.sn, amber)) flips++;
    }
  return flips;
}
const totalLC = perClose.length * LEG_FIELD.length;
for (const [name, a] of [["pctile-mapped", ambMap], ["naive 0.0625", 0.0625]] as const) {
  if (Number.isNaN(a)) { console.log(`amber candidate ${name}: n/a (no CISS-active samples)`); continue; }
  console.log(`amber candidate ${name} (${a.toFixed(4)}): regime flips ${flipCount(a)}/${totalLC} leg-closes vs today`);
}

// ---------- C ----------
console.log(`\n== C. Held-pick churn (${perClose.length} closes ≈ ${(perClose.length / 252).toFixed(2)} trading-yrs) ==`);
function churn(arm: "old" | "new") {
  let prevHeld: string | null = null;
  let prevTarget: number | null = null;
  let changes = 0;
  const flipsAt: number[] = [];
  const dist = new Map<string, number>();
  let closeIdx = 0;
  for (const pc of perClose) {
    const ld = new Map<string, number>();
    for (const leg of LEG_FIELD) {
      const p = pc.pill.get(leg.sleeve)!;
      ld.set(leg.sleeve, arm === "old"
        ? oldCombine(p.ewS, p.snS)
        : Math.max(p.ew.live ? p.ew.value : 0, p.sn.live ? p.sn.value : 0));
    }
    const held = heldPick(ld, pc.band, prevTarget, pc.targetRung);
    if (prevHeld !== null && held !== null && held !== prevHeld) { changes++; flipsAt.push(closeIdx); }
    if (held !== null) { prevTarget = (LADDER as readonly string[]).indexOf(held) + 1 || prevTarget; prevHeld = held; }
    // NOT a `lib/stats.ts` `countBy` site: this tally accumulates inside the replay's own
    // stateful per-close loop (alongside `changes`/`prevTarget`), not over a materialised
    // array — same output shape, different input. Leave inline.
    dist.set(held ?? "-", (dist.get(held ?? "-") ?? 0) + 1);
    closeIdx++;
  }
  let max10 = 0;
  for (const f of flipsAt) max10 = Math.max(max10, flipsAt.filter((x) => x >= f && x < f + 10).length);
  return { changes, perYear: changes / (perClose.length / 252), max10, dist: [...dist.entries()].sort((a, b) => b[1] - a[1]) };
}
for (const arm of ["old", "new"] as const) {
  const c = churn(arm);
  console.log(`${arm === "old" ? "OLD power-mean+veto (static)" : "NEW worst-of (CISS)  "}: held changes=${c.changes} (${c.perYear.toFixed(1)}/yr)  max flips in any 10-close window=${c.max10}`);
  console.log(`  held distribution: ${c.dist.map(([k, v]) => `${k}:${v}`).join("  ")}`);
}
