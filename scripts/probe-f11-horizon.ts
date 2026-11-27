/**
 * probe-f11-horizon.ts — Stage 2a falsifier 1 of the F11 scorer redesign:
 * F11's speed-axis re-horizon (`velocityWindow` 20 → 60) measured as a RESCORE, plus the red-day
 * count per 3y the stage owes as evidence.
 *
 *   npm run probe:f11-horizon   # = bash scripts/with-prod-config.sh tsx scripts/probe-f11-horizon.ts --env=prod
 *   npm run probe:f11-horizon
 *
 * WHY IT EXISTS — AND WHY `probe-leg-ordering.ts` CANNOT SERVE THIS MEASUREMENT.
 * `probe-leg-ordering` reconstructs its panel from `store.getSeries(...)` through
 * `lib/replay-walk.ts`'s `panelAt`/`ffillReadings`, both of which read the PERSISTED `readings.state`
 * column (`readings.push({ id, state: p.state })`). A `velocityWindow` edit in `registry.ts` does not
 * move a single persisted row until `scripts/backfill.ts --restate=F11` runs, and that restate is
 * gated behind `make ship` (Stage 2b). So a naive before/after through that probe is **A/A by
 * construction** — both arms would read the same Δ20-vintage column. VERIFIED, not assumed: see the
 * `p.state` reads in `ffillReadings` and `panelAt`.
 *
 * THE SEAM THIS PROBE USES INSTEAD is the one `--restate=` itself scores through:
 * `indicatorReadingSeries(indicator, observations, cuts)` (`src/scorers-core.ts`) — exactly
 * `backfill.ts`'s `const fred = (ind) => indicatorReadingSeries(ind, await fredObs(...), cutsFor(ind))`
 * — with `cuts = resolveCuts(id, synthesizedCalib(ind, vintage, synthHistories), direction)`, the
 * `scoreWithCuts` composition `backfillAll` builds. That call chain carries:
 *   · the scored/persisted `delta20` window (`scoreDaySeries` + `buildReadings`, both
 *     `velocityWindow ?? VELOCITY_WINDOW`, including the `w > VELOCITY_WINDOW` head clamp), AND
 *   · the runtime velocity PERCENTILE window (`computeSynthCutsDetailed`, `velocityWindow ??
 *     SYNTH_VEL_WINDOW`) — F11 is a `SYNTH_PRIOR_IDS` member, so its live cuts ARE that percentile,
 * so both halves move together, as `registry.ts`'s "ONE field moves BOTH windows" note requires.
 *   · the confirm fold exactly as production applies it: `buildReadings` folds `rawStates` through
 *     `asymConfirmedStateSeries(rawStates, confirmClosesFor(id))`. It is IMPORTED via that seam, never
 *     re-typed here — this probe reads the emitted `.state`, so whatever depth the tier table holds
 *     is what it measures (2 since 2026-08-26: instant-up, 2-close stand-down).
 *
 * NO REGISTRY MUTATION. The window is parameterised by SPREADING the shipped `Indicator`
 * (`{ ...f11, velocityWindow: w }`) into the seam, so no global constant is monkey-patched and the
 * two arms cannot leak into each other through module state. Everything else — cuts resolution,
 * thresholds, direction, the fold — is the shipped code path.
 *
 * ARMS. BEFORE = `velocityWindow` 20 (the pre-Stage-2a horizon, an in-probe literal: a control arm
 * imported from production is exactly the A/A collapse `lib/replay-walk.ts` warns about). AFTER = the
 * SHIPPED registry value, read off the indicator, so a revert cannot leave this probe reporting a
 * horizon it no longer measures — `check 0` ABORTS when the two coincide.
 *
 * OBSERVATIONS come from the prod store's `value` column (the DEXCHUS closes themselves), not from a
 * FRED refetch: the level series is the same quantity either way, and prod is the ruled store for
 * both arms (the dev store has no cron, so its recency is all-stale by construction).
 *
 * THE LADDER EVALUATION is `probe-leg-ordering.ts`'s panel assembly verbatim —
 * forward-fill → `computeFamilyPanel` → `computeT1Dial` → `computeField`, `prevTarget = null`, no
 * freshness stamp — with F11's state SUBSTITUTED per arm. The substitution covers the panel reading
 * AND F11's own `cissHistory` slice (`state`/`rawState`/`delta20`), because `buildMemberStateHeld`
 * reads that history; substituting only the reading would put the two arms'
 * held maps on the same Δ20 vintage and understate the move. Nothing else differs between the arms.
 *
 * ⚠ STEP 4 IS A POPULATION SWEEP, NOT ONE ANCHOR — AND THAT CORRECTION IS THE POINT.
 * The first version of this probe evaluated exactly ONE close (the latest separating one), found the
 * 9-leg table identical there, and the commit that shipped it generalised that n=1 into an "F11 is
 * absorbed by the family fold" PROPERTY. The population refutes it: swept over every separating close,
 * the ladder moves on a large minority of them. So step 4 now evaluates BOTH ARMS AT EVERY separating
 * close and prints three counts against the separating-close denominator: closes where any leg row
 * moved, where band/target rung moved, where the HELD sleeve moved (the user-visible rotation output).
 * A single-close collapse is a fact about that close and nothing more — never write it as a property.
 * COST PATH: one ascending `makeCursor` walk shared across the swept closes (`probe-leg-ordering.ts`
 * `--walk`'s mechanism, and its invariant: the cursor is ascending-only, so the swept dates must be
 * sorted, which they are — they come off `scoredDates`). The two drawn tables reuse the panels the
 * sweep already built, so no close is scanned twice.
 *
 * STEP 5 DRAWS TWO TABLES, both labelled for what they are: the latest close where the ladder MOVED
 * (the informative one) and the latest separating close (kept as the contrast case — it can be a
 * SATURATED dial, where no single member's move can show, which is exactly how the n=1 error happened).
 *
 * COLLAPSE AT ONE CLOSE IS A RESULT, NOT A FAILURE — but it is scoped PER DIMENSION and PER CLOSE. The
 * sensitivity control forces F11 to GREEN and to RED through the same seam and reports liveness
 * separately for the leg rows and for band/target/held, because F11 can be live on the rows and inert
 * on the band at the same close; one OR-ed verdict over both would license the wrong half. ⚠ The force
 * overwrites `state`+`rawState` across F11's WHOLE history slice (`MEMBER_WINDOW + MEMBER_HISTORY_PAD`
 * points), not just the anchor close — a deliberately LARGER perturbation than the arms' own, so it
 * bounds what F11 could do here rather than mirroring what it does.
 * An EMPTY differing-close set is likewise a result: "the horizon change moves no close", printed
 * loudly, with steps 4–5 skipped (there is no separating close at which to evaluate anything).
 *
 * `--asOf=<date>` pins the drawn table to one close. It is GUARDED: the anchor must be a separating
 * close (F11's two arms must differ at the date the forward-fill lands on), otherwise the two panels
 * are byte-identical and every verdict under it is A/A by construction. Before that guard existed,
 * `--asOf=2026-07-31` printed a full COLLAPSE VERDICT and `ALL CHECKS PASS` off an A/A comparison.
 *
 * ⚠ STRICTLY READ-ONLY: the only store calls are `getSeries`, `getSeriesBulk` (via
 * `loadSynthHistories`) and `getCalibration` — all selects. Nothing inserts, updates, upserts or
 * deletes.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { INDICATORS } from "../src/registry-fred.js";
import { indicatorReadingSeries } from "../src/scorers-core.js";
import { resolveCuts } from "../src/domain-cuts.js";
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import type { Indicator, Observation } from "../src/domain-types.js";
import { synthesizedCalib, loadSynthHistories } from "../src/synth-cuts.js";
import { computeFamilyPanel, LADDER } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import {
  computeField,
  legRAG,
  pillarValue,
} from "../src/danger-engine.js";
import { buildMemberState, buildMemberStateHeld, noHoldDepth } from "../src/danger-member-state.js";
import type { State } from "../src/domain-types.js";
import type { SeriesPoint } from "../src/store.js";
import { argOf, envArgStrict } from "./lib/cli.js";
import { loadSeriesWith, unionCalendar, panelAt, makeCursor, type Panel, MEMBER_WINDOW } from "./lib/replay-walk.js";

/** The indicator under measurement. */
const ID = "F11";
/** The PRE-Stage-2a horizon — an in-probe literal on purpose (see the docblock's ARMS note). */
const BEFORE_WINDOW = 20;
/** Mirrors `dial-assembly.ts`'s private `MEMBER_HISTORY_PAD` (=30), as the sibling probes do. */
const MEMBER_HISTORY_PAD = 30;
const FETCH_LIMIT = 20_000;
/** Trailing block length for the red-day table, in whole calendar years. */
const BLOCK_YEARS = 3;

const envArg = envArgStrict("prod");
const asOfArg = argOf("asOf");

const f11 = INDICATORS.find((i) => i.id === ID);
if (f11 === undefined) {
  console.log(`ABORT: ${ID} is absent from INDICATORS — this probe measures its velocity horizon.`);
  process.exit(1);
}
const AFTER_WINDOW = f11.velocityWindow ?? VELOCITY_WINDOW;

let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(`ABORT: no ${envArg} store reachable — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries / getSeriesBulk / getCalibration select only) ----------
const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeriesWith((id) => store.getSeries(id, FETCH_LIMIT), memberIds);
const f11Points = seriesById.get(ID) ?? [];
if (f11Points.length === 0) {
  console.log(`ABORT: the ${envArg} store returned zero ${ID} closes — nothing to rescore.`);
  process.exit(1);
}
const observations: Observation[] = f11Points.map((p) => ({ date: p.date, value: p.value }));
const vintage = await store.getCalibration().catch(() => []);
const synthHistories = await loadSynthHistories(store);

console.log(
  `[probe-f11-horizon] Stage 2a falsifier 1 — ${ID} velocity-horizon rescore, BEFORE w=${BEFORE_WINDOW} vs ` +
    `AFTER w=${AFTER_WINDOW} (shipped)\n` +
    `  STORE: ${envArg} · SEAM: indicatorReadingSeries + resolveCuts(synthesizedCalib(...)) — the ` +
    `--restate= path\n` +
    `  ${ID}: ${observations.length} stored closes ${observations[0]!.date} .. ${observations.at(-1)!.date}`,
);

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok = ok && pass;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- check 0: the arms must actually differ, or every verdict below is vacuous ----------
if (AFTER_WINDOW === BEFORE_WINDOW) {
  console.log(
    `ABORT: ${ID}.velocityWindow at HEAD is ${AFTER_WINDOW}, equal to this probe's BEFORE literal ` +
      `(${BEFORE_WINDOW}) — both arms would score the SAME window and the whole measurement would be ` +
      `A/A by construction. Either Stage 2a's registry edit was reverted (see registry.ts §${ID}) or ` +
      `this probe's BEFORE_WINDOW needs re-basing onto the horizon actually superseded.`,
  );
  process.exit(1);
}

// ---------- step 1: two confirmed-state series over the SAME prod values ----------
/** One arm: the shipped scoring seam with ONLY `velocityWindow` moved. */
function armSeries(w: number): { states: Map<string, State>; deltas: Map<string, number>; raw: Map<string, State> } {
  const ind: Indicator = { ...f11!, velocityWindow: w };
  const cuts = resolveCuts(ind.id, synthesizedCalib(ind, vintage, synthHistories), ind.direction ?? "HIGH");
  const readings = indicatorReadingSeries(ind, observations, cuts);
  return {
    states: new Map(readings.map((r) => [r.date, r.state])),
    raw: new Map(readings.map((r) => [r.date, r.rawState])),
    deltas: new Map(readings.map((r) => [r.date, r.delta20])),
  };
}
const before = armSeries(BEFORE_WINDOW);
const after = armSeries(AFTER_WINDOW);

const scoredDates = [...before.states.keys()].filter((d) => after.states.has(d)).sort();
check(
  "both arms scored the same close set (comparable denominators)",
  before.states.size === after.states.size && scoredDates.length === before.states.size,
  `before ${before.states.size} · after ${after.states.size} · shared ${scoredDates.length}`,
);
if (scoredDates.length === 0) {
  console.log("ABORT: no shared scored close between the arms — nothing to compare.");
  process.exit(1);
}

// ---------- step 2: red-day count per trailing 3-year block ----------
/** `iso` shifted back `n` whole calendar years, with the day CLAMPED into the target month — a naive
 *  string decrement turns a Feb-29 anchor into `YYYY-02-29` in a non-leap year, a date no close can
 *  ever equal, which would silently mis-bound the block it opens. */
const shiftYears = (iso: string, n: number): string => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const ty = y - n;
  const daysInMonth = new Date(Date.UTC(ty, m, 0)).getUTCDate(); // day 0 of month m = last day of m-1 (1-based m)
  return `${String(ty).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, daysInMonth)).padStart(2, "0")}`;
};
const last = scoredDates.at(-1)!;
const first = scoredDates[0]!;
interface Block {
  label: string;
  from: string;
  to: string;
  n: number;
  redBefore: number;
  redAfter: number;
}
const blocks: Block[] = [];
for (let k = 0; ; k++) {
  const to = k === 0 ? last : shiftYears(last, k * BLOCK_YEARS);
  const from = shiftYears(last, (k + 1) * BLOCK_YEARS);
  // Half-open on the left so the blocks partition the axis exactly once: (from, to].
  const inBlock = scoredDates.filter((d) => d > from && d <= to);
  if (inBlock.length > 0) {
    blocks.push({
      label: k === 0 ? "T-0" : `T-${k * BLOCK_YEARS}y`,
      from,
      to,
      n: inBlock.length,
      redBefore: inBlock.filter((d) => before.states.get(d) === "RED").length,
      redAfter: inBlock.filter((d) => after.states.get(d) === "RED").length,
    });
  }
  if (from <= first) break;
}
const totalRedBefore = scoredDates.filter((d) => before.states.get(d) === "RED").length;
const totalRedAfter = scoredDates.filter((d) => after.states.get(d) === "RED").length;

console.log(
  `\n══ STEP 2 — RED-day count per trailing ${BLOCK_YEARS}y block (non-overlapping, anchored at ${last}) ══\n` +
    `  ${ID} confirmed state, ${envArg} store · denominator = scored closes in the block\n` +
    `  block  | window                    |     n | RED w=${String(BEFORE_WINDOW).padEnd(2)} |  rate | RED w=${String(AFTER_WINDOW).padEnd(2)} |  rate`,
);
const pct = (a: number, b: number) => (b === 0 ? "   na" : `${((100 * a) / b).toFixed(1).padStart(4)}%`);
for (const b of blocks) {
  console.log(
    `  ${b.label.padEnd(6)} | (${b.from} .. ${b.to}] | ${String(b.n).padStart(5)} | ` +
      `${String(b.redBefore).padStart(6)} | ${pct(b.redBefore, b.n)} | ${String(b.redAfter).padStart(6)} | ${pct(b.redAfter, b.n)}`,
  );
}
console.log(
  // CLOSED on both ends here, unlike the per-block rows: the total's denominator INCLUDES `first`,
  // which a `(first ..` notation would exclude.
  `  ${"TOTAL".padEnd(6)} | [${first} .. ${last}] | ${String(scoredDates.length).padStart(5)} | ` +
    `${String(totalRedBefore).padStart(6)} | ${pct(totalRedBefore, scoredDates.length)} | ` +
    `${String(totalRedAfter).padStart(6)} | ${pct(totalRedAfter, scoredDates.length)}`,
);
console.log(
  `  observations: BEFORE arm ${before.states.size} scored closes · AFTER arm ${after.states.size} scored closes ` +
    `(both over the same ${observations.length} stored ${ID} rows)`,
);

// ---------- step 3: the differing closes ----------
const differing = scoredDates.filter((d) => before.states.get(d) !== after.states.get(d));
const pairs = new Map<string, number>();
for (const d of differing) {
  const key = `${before.states.get(d)} → ${after.states.get(d)}`;
  pairs.set(key, (pairs.get(key) ?? 0) + 1);
}
console.log(
  `\n══ STEP 3 — closes where the two arms' CONFIRMED state DIFFERS ══\n` +
    `  ${differing.length} of ${scoredDates.length} scored closes (${pct(differing.length, scoredDates.length)}), ` +
    `${first} .. ${last}`,
);
for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)} closes`);
}
if (differing.length === 0) {
  console.log(
    `\n  ⚑ VERDICT: THE HORIZON CHANGE MOVES NO CLOSE. w=${BEFORE_WINDOW} and w=${AFTER_WINDOW} produce a\n` +
      `    byte-identical ${ID} confirmed-state series over all ${scoredDates.length} scored prod closes. That is a\n` +
      `    RESULT, not a probe failure: with the cuts re-measured as a percentile of |Δw| on each arm's own\n` +
      `    horizon, the re-basing is self-cancelling on this history. No separating close exists, so the\n` +
      `    population sweep (step 4) and the 9-leg ordering tables (step 5) are not drawn — there is no\n` +
      `    close at which to draw them.`,
  );
  console.log(`\n[probe-f11-horizon] ${ok ? "ALL CHECKS PASS" : "CHECKS FAILED"} (steps 4–5 skipped: no separating close)`);
  process.exit(ok ? 0 : 1);
}
const latestDiff = differing.at(-1)!;
console.log(`  latest differing close: ${latestDiff} (${before.states.get(latestDiff)} → ${after.states.get(latestDiff)})`);

// ---------- the shared ladder-evaluation seam (used by the step-4 sweep AND the step-5 tables) ------
const axis = unionCalendar(seriesById, memberIds);
const PANEL_HISTORY_LEN = MEMBER_WINDOW + MEMBER_HISTORY_PAD;

/** The F11 point the forward-fill actually lands on at `at` — the arm state must be read at THAT date,
 *  not at `at`, or a stale-F11 close would be substituted with a state F11 never carried. */
const ffillDateAt = (at: string): string | null => {
  const i = f11Points.findLastIndex((p) => p.date <= at);
  return i < 0 ? null : f11Points[i]!.date;
};

interface Arm {
  states: Map<string, State>;
  raw: Map<string, State>;
  deltas: Map<string, number>;
}
/** The arm's panel: the shipped one with F11's reading AND its own history slice restated. */
function armPanel(arm: Arm, base: Panel, ffillDate: string): Panel {
  const restate = (p: SeriesPoint): SeriesPoint => {
    const s = arm.states.get(p.date);
    if (s === undefined) return p; // pre-warm-up point: no arm state exists — leave the stored one
    return { ...p, state: s, rawState: arm.raw.get(p.date) ?? p.rawState, delta20: arm.deltas.get(p.date) ?? p.delta20 };
  };
  return {
    readings: base.readings.map((r) => (r.id === ID ? { id: ID, state: arm.states.get(ffillDate)! } : r)),
    cissHistory: base.cissHistory.map((h) =>
      h.id === ID ? ({ id: ID, history: h.history.map(restate) }) : h,
    ),
  };
}

interface Row {
  rank: number;
  rung: number;
  sleeve: string;
  danger: number;
  ew: number | null;
  sn: number | null;
  rag: State;
  inBand: boolean;
}
interface ArmResult {
  rows: Row[];
  band: { lo: number; hi: number };
  targetRung: number;
  held: string | null;
}
/** `probe-leg-ordering.ts`'s shipped-path arm, verbatim (no `--before=` counterfactual seams). */
function evaluate(at: Panel): ArmResult {
  const panel = computeFamilyPanel(at.readings, DIAL_FAMILIES);
  const heldMemberState = noHoldDepth(at.cissHistory)
    ? buildMemberState({ globalFamilies: panel.families })
    : buildMemberStateHeld({ globalFamilies: panel.families }, at.cissHistory);
  const dial = computeT1Dial(panel.families, techConfirmerBreadth(techConfirmerFromPanel(panel.families, undefined, heldMemberState)));
  const field = computeField({ globalFamilies: panel.families }, dial.band, undefined, null, at.cissHistory);
  const rows: Row[] = field.legRows
    .map((r) => ({
      rank: 0,
      rung: LADDER.indexOf(r.sleeve as (typeof LADDER)[number]) + 1,
      sleeve: r.sleeve,
      danger: r.danger,
      ew: pillarValue(r.subDangers.earlyWarn),
      sn: pillarValue(r.subDangers.stressNow),
      rag: legRAG(r.cells),
      inBand: r.risk >= dial.band.lo && r.risk <= dial.band.hi,
    }))
    .sort((a, b) => a.danger - b.danger || a.rung - b.rung)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return { rows, band: dial.band, targetRung: dial.targetRung, held: field.held?.sleeve ?? null };
}
// ---------- the per-dimension move detectors ----------
const EPS = 1e-12;
const sameRow = (a: Row, b: Row) =>
  a.rank === b.rank &&
  a.sleeve === b.sleeve &&
  Math.abs(a.danger - b.danger) <= EPS &&
  (a.ew === null ? b.ew === null : b.ew !== null && Math.abs(a.ew - b.ew) <= EPS) &&
  (a.sn === null ? b.sn === null : b.sn !== null && Math.abs(a.sn - b.sn) <= EPS) &&
  a.rag === b.rag &&
  a.inBand === b.inBand;
const rowMap = (a: ArmResult) => new Map(a.rows.map((r) => [r.sleeve, r]));
/** The LADDER sleeves whose row differs between two evaluations (rank, danger, EW/SN, RAG, inBand). */
const movedLegs = (x: ArmResult, y: ArmResult): string[] => {
  const xm = rowMap(x);
  const ym = rowMap(y);
  return LADDER.filter((s) => {
    const b = xm.get(s);
    const a = ym.get(s);
    return b === undefined || a === undefined ? false : !sameRow(b, a);
  });
};
/** Rows moved as a boolean, INCLUDING a roster-size change (which `movedLegs` alone cannot express).
 *  ⚠ This is the WIDE test: ANY printed field of the row (rank, danger, EW, SN, RAG, inBand). A leg whose
 *  `stressNow` pillar shifts while its `danger` max does not counts as moved here — correctly, since the
 *  drawn table changes — so this count is strictly ≥ the ORDERING-only count below. Report which one you
 *  are quoting; they are different questions. */
const rowsMoved = (x: ArmResult, y: ArmResult) => x.rows.length !== y.rows.length || movedLegs(x, y).length > 0;
/** The NARROW test: only the ordering itself — a leg's rank or its `danger` value. */
const orderingMoved = (x: ArmResult, y: ArmResult): boolean => {
  if (x.rows.length !== y.rows.length) return true;
  const ym = rowMap(y);
  return x.rows.some((b) => {
    const a = ym.get(b.sleeve);
    return a === undefined || a.rank !== b.rank || Math.abs(a.danger - b.danger) > EPS;
  });
};
const bandTargetMoved = (x: ArmResult, y: ArmResult) =>
  x.band.lo !== y.band.lo || x.band.hi !== y.band.hi || x.targetRung !== y.targetRung;
const heldMoved = (x: ArmResult, y: ArmResult) => x.held !== y.held;

// ---------- step 4: does the ladder move? SWEPT OVER THE WHOLE SEPARATING SET ----------
// ⚠ THE HEADLINE RESULT. One anchor cannot answer this — see the docblock's STEP 4 note. The cursor is
// shared and ascending-only (`probe-leg-ordering.ts` --walk's mechanism), so `sweepDates` must be
// sorted: it is, being a filter of the sorted `scoredDates`.
const sweepDates = differing.filter((d) => d >= axis[0]! && d <= axis.at(-1)!);
const sweepCursor = makeCursor(seriesById);
interface Anchor {
  asOf: string;
  panel: Panel;
  ffillDate: string;
}
let evaluated = 0;
let skipped = 0;
let nRowsMoved = 0;
let nOrderingMoved = 0;
let nBandTargetMoved = 0;
let nHeldMoved = 0;
let lastAnchor: Anchor | null = null;
let lastMovedAnchor: Anchor | null = null;
let lastHeldAnchor: Anchor | null = null;
const heldMovedDates: string[] = [];
for (const d of sweepDates) {
  const panel = panelAt(seriesById, memberIds, d, { historyLen: PANEL_HISTORY_LEN, cursor: sweepCursor });
  const fd = ffillDateAt(d);
  // Skip only what cannot be evaluated at all: no observed member, F11 absent from the panel, or no arm
  // state at the ffilled date. Each would make the two arms identical BY CONSTRUCTION at this close, so
  // counting it as "did not move" would bias the headline downwards.
  if (panel.readings.length === 0 || fd === null || !panel.readings.some((r) => r.id === ID) || !before.states.has(fd)) {
    skipped++;
    continue;
  }
  const rb = evaluate(armPanel(before, panel, fd));
  const ra = evaluate(armPanel(after, panel, fd));
  evaluated++;
  const anchor: Anchor = { asOf: d, panel, ffillDate: fd };
  lastAnchor = anchor;
  const rm = rowsMoved(rb, ra);
  const bm = bandTargetMoved(rb, ra);
  const hm = heldMoved(rb, ra);
  if (rm) nRowsMoved++;
  if (orderingMoved(rb, ra)) nOrderingMoved++;
  if (bm) nBandTargetMoved++;
  if (hm) {
    nHeldMoved++;
    heldMovedDates.push(d);
    lastHeldAnchor = anchor;
  }
  if (rm || bm || hm) lastMovedAnchor = anchor;
}
console.log(
  `\n══ STEP 4 — does the re-horizon move the LADDER? swept over EVERY separating close ══\n` +
    `  population: ${sweepDates.length} separating closes of ${scoredDates.length} scored ` +
    `(${pct(sweepDates.length, scoredDates.length)}), ${first} .. ${last} · evaluated ${evaluated} · skipped ${skipped}\n` +
    `  denominator for every count below = the ${evaluated} EVALUATED separating closes\n` +
    `  · any leg row moved      : ${String(nRowsMoved).padStart(4)} (${pct(nRowsMoved, evaluated)} of separating · ` +
    `${pct(nRowsMoved, scoredDates.length)} of all scored)   [WIDE: rank|danger|EW|SN|RAG|inBand]\n` +
    `  · leg ORDERING moved     : ${String(nOrderingMoved).padStart(4)} (${pct(nOrderingMoved, evaluated)} of separating · ` +
    `${pct(nOrderingMoved, scoredDates.length)} of all scored)   [NARROW: rank|danger only]\n` +
    `  · band/target rung moved : ${String(nBandTargetMoved).padStart(4)} (${pct(nBandTargetMoved, evaluated)} of separating · ` +
    `${pct(nBandTargetMoved, scoredDates.length)} of all scored)\n` +
    `  · HELD sleeve moved      : ${String(nHeldMoved).padStart(4)} (${pct(nHeldMoved, evaluated)} of separating · ` +
    `${pct(nHeldMoved, scoredDates.length)} of all scored)  ← the user-visible rotation output`,
);
if (heldMovedDates.length > 0) {
  const shown = heldMovedDates.slice(0, 6).join(" ");
  console.log(`  held-moved closes (first ${Math.min(6, heldMovedDates.length)}): ${shown}${heldMovedDates.length > 6 ? " …" : ""}`);
}
console.log(
  nRowsMoved === 0
    ? `\n  ⚑ POPULATION VERDICT: the re-horizon moves NO leg row at ANY of the ${evaluated} separating closes.\n` +
        `    THAT is the only form in which absorption may be claimed — and only for this history.`
    : `\n  ⚑ POPULATION VERDICT: the re-horizon MOVES the 9-leg table on ${nRowsMoved} of ${evaluated} separating closes.\n` +
        `    It is NOT absorbed by the family fold as a property. A collapse at any single close is a fact\n` +
        `    about that close only; each step-5 table below says in its own verdict whether the dial was\n` +
        `    SATURATED there, which is the configuration in which no single member's move can show.`,
);
if (evaluated === 0) {
  console.log(`\n[probe-f11-horizon] ${ok ? "ALL CHECKS PASS" : "CHECKS FAILED"} (step 5 skipped: no evaluable separating close)`);
  process.exit(ok ? 0 : 1);
}

// ---------- step 5: the 9-leg LADDER ordering table(s), BEFORE vs AFTER ----------
const f3 = (n: number | null) => (n === null ? "   na" : n.toFixed(3).padStart(5));
function drawTable(anchor: Anchor, caption: string): void {
  const { asOf, panel: basePanel, ffillDate } = anchor;
  const armBefore = evaluate(armPanel(before, basePanel, ffillDate));
  const armAfter = evaluate(armPanel(after, basePanel, ffillDate));
  console.log(
    `\n══ STEP 5 — 9-leg danger ordering over LADDER at ${asOf} — ${caption} ══\n` +
      `  ${basePanel.readings.length}/${memberIds.length} dial members observed · ` +
      `${ID} ffilled from ${ffillDate}: BEFORE ${before.states.get(ffillDate)} vs AFTER ${after.states.get(ffillDate)}\n` +
      `  BEFORE (w=${BEFORE_WINDOW}): band=[${armBefore.band.lo},${armBefore.band.hi}] targetRung=${armBefore.targetRung} held=${armBefore.held ?? "(none)"}\n` +
      `  AFTER  (w=${AFTER_WINDOW}): band=[${armAfter.band.lo},${armAfter.band.hi}] targetRung=${armAfter.targetRung} held=${armAfter.held ?? "(none)"}\n` +
      `  rank | rung | leg       | BEFORE danger    EW    SN RAG   inBand | AFTER  danger    EW    SN RAG   inBand | Δdanger`,
  );
  // Printed by LADDER rung so the two arms' rows line up member-for-member even when the ranks permute.
  const bMap = rowMap(armBefore);
  const aMap = rowMap(armAfter);
  for (const sleeve of LADDER) {
    const b = bMap.get(sleeve);
    const a = aMap.get(sleeve);
    if (b === undefined || a === undefined) continue;
    console.log(
      `  ${String(b.rank).padStart(2)}→${String(a.rank).padStart(2)} | ${String(b.rung).padStart(4)} | ${sleeve.padEnd(9)} | ` +
        `       ${f3(b.danger)} ${f3(b.ew)} ${f3(b.sn)} ${b.rag.padEnd(5)} ${b.inBand ? "yes" : "no "}    | ` +
        `       ${f3(a.danger)} ${f3(a.ew)} ${f3(a.sn)} ${a.rag.padEnd(5)} ${a.inBand ? "yes" : "no "}    | ` +
        (a.danger - b.danger).toFixed(12),
    );
  }
  const legs = movedLegs(armBefore, armAfter);
  const rm = rowsMoved(armBefore, armAfter);
  const bm = bandTargetMoved(armBefore, armAfter);
  const hm = heldMoved(armBefore, armAfter);
  // "Saturated" = the dial is pinned at the LADDER's defensive end on BOTH arms and no leg is GREEN. That
  // is the configuration in which no single member's move can show, and it is why an n=1 collapse at such
  // a close was mistaken for absorption. A merely narrow band is NOT saturation — the band can still move.
  const pinned = (a: ArmResult) => a.band.lo === LADDER.length && a.band.hi === LADDER.length;
  const dialSaturated = pinned(armBefore) && pinned(armAfter) && armBefore.rows.every((r) => r.rag !== "GREEN");
  // SENSITIVITY CONTROL (the non-vacuity of any UNCHANGED verdict at this close). An "unchanged" claim is
  // only informative if the substitution path reaches the engine AT ALL here. Force F11 to the two
  // extremes through the SAME substitution seam and re-evaluate: if even GREEN-vs-RED cannot move a
  // dimension, F11 is inert on it here for reasons that have nothing to do with the horizon.
  // ⚠ The force overwrites state+rawState across F11's WHOLE history slice (PANEL_HISTORY_LEN points),
  // not just the anchor close — a deliberately LARGER perturbation than the arms', so it bounds what F11
  // COULD do here. It is a control, not a mirror of the arms.
  const forced = (s: State): Panel => ({
    readings: basePanel.readings.map((r) => (r.id === ID ? { id: ID, state: s } : r)),
    cissHistory: basePanel.cissHistory.map((h) =>
      h.id === ID ? ({ id: ID, history: h.history.map((p) => ({ ...p, state: s, rawState: s })) }) : h,
    ),
  });
  const placeboGreen = evaluate(forced("GREEN"));
  const placeboRed = evaluate(forced("RED"));
  const placeboLegs = movedLegs(placeboGreen, placeboRed);
  const placeboRows = rowsMoved(placeboGreen, placeboRed);
  const placeboBand = bandTargetMoved(placeboGreen, placeboRed);
  const placeboHeld = heldMoved(placeboGreen, placeboRed);
  // ⚠ SCOPED PER DIMENSION, never OR-ed: F11 can be live on the leg rows and inert on the band at the
  // same close, and one OR-ed verdict would license the band half off the rows half's evidence.
  console.log(
    `\n  PLACEBO (sensitivity control, forcing ${ID} GREEN vs RED across its whole ${PANEL_HISTORY_LEN}-point history slice):\n` +
      `    · leg rows        : ${placeboRows ? `MOVE [${placeboLegs.join(",")}]` : "do NOT move"} ⇒ any "rows unchanged" verdict here is ${
        placeboRows ? "informative" : "UNINFORMATIVE (rows inert under every state)"
      }\n` +
      `    · band/target     : ${placeboBand ? "MOVE" : "do NOT move"} ⇒ any "band/target unchanged" verdict here is ${
        placeboBand ? "informative" : "UNINFORMATIVE (band inert under every state)"
      }\n` +
      `    · held sleeve     : ${placeboHeld ? "MOVES" : "does NOT move"} ⇒ any "held unchanged" verdict here is ${
        placeboHeld ? "informative" : "UNINFORMATIVE (held inert under every state)"
      }`,
  );
  const scoped = (movedFlag: boolean, live: boolean, what: string, detail: string) =>
    movedFlag
      ? `    · ${what.padEnd(13)}: MOVED ${detail}`
      : `    · ${what.padEnd(13)}: unchanged — ${live ? "a real collapse at THIS close (the placebo shows the seam is live on it)" : "UNINFORMATIVE (placebo-inert here)"}`;
  console.log(
    `\n  ⚑ PER-DIMENSION VERDICT at ${asOf}${dialSaturated ? " (⚠ DIAL SATURATED: band=[" + armBefore.band.lo + "," + armBefore.band.hi + "] and no GREEN leg — the close where a single member's move is LEAST able to show)" : ""}:\n` +
      `${scoped(rm, placeboRows, "leg rows", `[${legs.join(",")}]`)}\n` +
      `${scoped(bm, placeboBand, "band/target", `band [${armBefore.band.lo},${armBefore.band.hi}] → [${armAfter.band.lo},${armAfter.band.hi}] · targetRung ${armBefore.targetRung} → ${armAfter.targetRung}`)}\n` +
      `${scoped(hm, placeboHeld, "held sleeve", `${armBefore.held ?? "(none)"} → ${armAfter.held ?? "(none)"}`)}\n` +
      `    ${ID}'s own confirmed state at ${ffillDate}: ${before.states.get(ffillDate)} → ${after.states.get(ffillDate)}. ` +
      `Scoped to this close — NOT a property of the fold.`,
  );
}

if (asOfArg !== undefined) {
  // A user-supplied anchor is NOT "the latest separating close" and must not be labelled one — and it is
  // not even guaranteed to be separating, which is what the two checks below establish.
  if (asOfArg < axis[0]! || asOfArg > axis.at(-1)!) {
    console.log(`ABORT: --asOf=${asOfArg} lies outside the store's close range ${axis[0]} .. ${axis.at(-1)}.`);
    process.exit(1);
  }
  const panel = panelAt(seriesById, memberIds, asOfArg, { historyLen: PANEL_HISTORY_LEN, cursor: makeCursor(seriesById) });
  const fd = ffillDateAt(asOfArg);
  const present = panel.readings.some((r) => r.id === ID);
  check(
    `${ID} is present in the panel at ${asOfArg} (its substitution is the ONLY arm difference)`,
    present && fd !== null && before.states.has(fd),
    `ffill date ${fd ?? "—"} · present ${present} · ${panel.readings.length} members observed`,
  );
  if (!present || fd === null || !before.states.has(fd)) {
    console.log(`ABORT: cannot substitute ${ID} at ${asOfArg} — the arms would be identical by construction.`);
    process.exit(1);
  }
  // THE GUARD. Without it a non-separating `--asOf` prints a full COLLAPSE VERDICT off an A/A comparison
  // and still exits `ALL CHECKS PASS` — the two panels are byte-identical when the arm states coincide.
  const sep = before.states.get(fd) !== after.states.get(fd);
  check(
    `--asOf=${asOfArg} is a SEPARATING close: ${ID}'s two arms differ at the ffilled date ${fd}`,
    sep,
    `BEFORE (w=${BEFORE_WINDOW}) ${before.states.get(fd)} vs AFTER (w=${AFTER_WINDOW}) ${after.states.get(fd)}`,
  );
  if (!sep) {
    console.log(
      `\nABORT: --asOf=${asOfArg} is NOT a separating close. ${ID}'s confirmed state is ` +
        `${before.states.get(fd)} on BOTH arms at the ffilled date ${fd}, so the two panels are identical\n` +
        `  byte-for-byte and any "unchanged" verdict under this anchor would be A/A BY CONSTRUCTION, not a\n` +
        `  measurement of the horizon. Pick a date from the ${sweepDates.length}-close separating set ` +
        `(latest: ${latestDiff}), or drop --asOf to let the probe choose.`,
    );
    process.exit(1);
  }
  drawTable({ asOf: asOfArg, panel, ffillDate: fd }, "user-supplied anchor (--asOf), verified separating");
} else {
  // Deterministic, most-informative-first, de-duplicated: the latest close where the HELD SLEEVE moved
  // (the user-visible rotation output), then the latest close where ANYTHING moved, then the latest
  // separating close — the last of which may be a saturated dial and is captioned as the contrast case.
  const drawn = new Set<string>();
  const draw = (a: Anchor | null, caption: string) => {
    if (a === null || drawn.has(a.asOf)) return;
    drawn.add(a.asOf);
    drawTable(a, caption);
  };
  draw(lastHeldAnchor, "LATEST close where the HELD SLEEVE moved — the user-visible rotation output");
  draw(lastMovedAnchor, "LATEST close where any ladder dimension moved");
  draw(lastAnchor, "latest separating close — CONTRAST case, kept for comparison only");
}

console.log(`\n[probe-f11-horizon] ${ok ? "ALL CHECKS PASS" : "CHECKS FAILED"}`);
process.exit(ok ? 0 : 1);
