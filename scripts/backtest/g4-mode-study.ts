/**
 * G4 — placebo event study on the `/lab` market-mode QUADRANT labels.
 * Rung 1 of the rotation remainder, under its §E-1…§E-3 execution rulings.
 *
 *     npm run g4:export-legs        # slice 1 — prod LEGP_* → scripts/backtest/data-g4/*.csv
 *     npm run g4:mode-study         # slices 2+4 — labels, study, verdict
 *
 * THE QUESTION, stated exactly: **did the mode label a leg carried on a close predict that leg's
 * forward return?** It is NOT the ACWI-relative rotation question (D19) — nothing here is measured
 * against a benchmark, only against each leg's OWN unconditional mean over the same window.
 *
 * ⚠ **ONE-SHOT, NOT REPRODUCIBLE ACROSS A RETUNE** (§Approach rulings, accepted cost). The labels are
 * RECOMPUTED retroactively under TODAY's constants — no per-close mode was ever persisted (D16's
 * migration was not built). Move `DANGER_CUTS.amber`, the growth fold, `Y1_LOOKBACKS`, or the family
 * weights and this study's labels change; the verdict then has to be RE-REGISTERED, not re-quoted.
 * `assertPreRegisteredConstants` below turns that sentence into a throw rather than a hope.
 *
 * ⚠ **THE LABEL RULE IS RE-IMPLEMENTED HERE, NEVER IMPORTED** (§E-1). `public/market-mode.js` is deliberately
 * NOT imported: an imported rule reads the retuned value the moment a retune ships, so the banked
 * verdict would silently re-base while still printing a populated table. The cut and the growth split
 * are in-probe LITERALS (`AMBER_CUT` / `GROWTH_MID`), and the pin below fails loudly if prod moves off
 * them. D14's cross-sectional median split is SUPERSEDED and is not implemented anywhere here.
 *
 * ⚠ **PROD, read-only** (`research-probes.md` §The instrument is a claim too): `getSeries` selects only; the dev DB has no cron, so a
 * label history reconstructed there would be an artifact of the last backfill.
 * Reads stored `LEGP_*` price rows, which exist only once a daily-closes source is bound and `retainable()` keeps them
 * (README §Data sources and extension points); with none it throws `LEGP_SPX is empty` before any replay.
 *
 * WHAT IS MEASURED WITH WHAT
 *   • danger + growth per (close, leg) — the SHIPPED `computeField`, fed the same `rsBySleeve` /
 *     `momBySleeve` maps `/lab` builds (`computeLegRs` / `computeVolAdjMom` over the persisted
 *     `LEGP_*` closes on/before that date). This is the no-`cissHistory` form,
 *     exactly as `probe:growth` ran (probe retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it)) — a documented valid `computeField` mode.
 *   • forward returns — the nine EXPORTED `LEGP_*` fixtures, so all nine legs are EXACT (§E-2): no
 *     `UNMEASURABLE` `Value` row and no non-EXACT proxy row, hence no leg needs an EXACT co-signer.
 *     (Under the committed `LEG_FIXTURE` proxies it WOULD — `LEG_EVIDENCE` grades `Value`
 *     UNMEASURABLE and `S&P IT` WEAK as of 2026-08-02; `Health` / `Staples` were WEAK there too until
 *     seating Stage 2 upgraded them. Read the live set off `LEG_EVIDENCE`, never off this line: an
 *     enumeration here rots every time a fixture is repointed — and it DID: on 2026-08-05 `Value` gained
 *     a committed fixture (`value.csv`) and its grade moved UNMEASURABLE → WEAK
 *     (the Value weight retune). The 2026-08-02 enumeration above is kept
 *     as the dated record; it is not the current set.)
 *   • the placebo, the episode count and the thin guard — the `event-study.ts` harness, unmodified in
 *     method. Nothing here re-implements rotation or bucket counting (§E-2).
 *
 * ABSENCE IS EMITTED, NEVER DEFAULTED. A (close, leg) that cannot resolve BOTH danger and a LIVE
 * growth is labelled `ABSENT` and passed to the harness as the `baselineBucket` — present in the
 * series (so rotation preserves clustering exactly) and never scored. Silent omission is how
 * "excluded" and "forgotten" become indistinguishable.
 */
import { writeFileSync } from "node:fs";
import { computeField, DANGER_CUTS, type LegRow } from "../../src/danger-engine.js";
import { DIAL_FAMILIES } from "../../src/dial-assembly.js";
import { computeFamilyPanel, LADDER } from "../../src/families.js";
import { legCloseId } from "../../src/scoreboard.js";
import { getStore, type SeriesPoint } from "../../src/store.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../../src/t1dial.js";
import { computeLegRs, computeVolAdjMom, Y1_MIN_OBS, Y1_PERSIST, type Sleeve } from "../../src/y1.js";
import {
  type EventStudyRow,
  HORIZONS_TD,
  type Leg,
  type LabelPoint,
  MIN_EPISODES,
  permutationP,
  runEventStudy,
} from "./event-study.js";
import { OUT_DIR_REL } from "./export-leg-fixtures.js";
import { argOf } from "../lib/cli.js";
import { calendarFrom, loadSeries, walkReplay } from "../lib/replay-walk.js";
import { readEnv } from "../../src/config.js";

const env = readEnv();

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE PRE-REGISTRATION — §E-3. FIXED BEFORE THE RUN. None of these may move after seeing a result.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Placebo arms: cyclic label rotations in the label series' own cadence. 199, widened from the
 *  harness's 6 fixed offsets — with 6 arms the best achievable p is 1/7 ≈ 0.143 and a `p ≤ 0.05`
 *  gate would be unsatisfiable by construction. */
const PLACEBO_ROTATIONS = 199;
/** Permutation p gate, on the rank of the real arm among the 199 + 1. */
const P_MAX = 0.05;
/** Effect-size floor: mean forward-excess spread, best mode minus worst, in percentage points. */
const SPREAD_FLOOR_PP = 1.0;
/**
 * A (mode, leg) cell with fewer contiguous label runs than `MIN_EPISODES` is THIN and is excluded
 * from the pooled mean. A MODE resting on fewer than this many legs makes the headline THIN — the
 * cross-leg mean must rest on a majority of the nine-leg ladder, not on a corner of it.
 *
 * ⚠ **ADDED AT RUN TIME — NOT PART OF THE §E-3 PRE-REGISTRATION.** Every other constant in this
 * block is quoted verbatim from the §E-3 pre-registration, fixed
 * before the run. This one is not: it appears nowhere in §E-3, nowhere in that doc's §Rung 1 pass-bar
 * row, and nowhere in the run commit's own restatement of the bar — it was written in the same commit
 * as the study. It is kept because the methodological reason is sound (a pooled cross-leg mean resting
 * on a corner of the ladder is not a statement about the ladder) and because it is **one-directional
 * by construction**: `verdict = thin ? "THIN" : clearsFloor && clearsP ? "PASS" : "FAIL"`, so this
 * clause can only ever BLOCK a PASS, never manufacture one. It is NOT harmless either — on the
 * 2026-08-02 run it is the sole source of `thinReason`, and removing it turns that run's THIN into the
 * FAIL §Rung 1 routes with no user input. That counterfactual is recorded in the verdict section of
 * the plan doc; do not let a later reader mistake this line for a pre-registered knob.
 */
const MIN_LEGS_PER_MODE = 5;

/** The SERVED green→amber leg-danger cut, frozen as an in-probe literal (§E-1). Never imported —
 *  see the file docblock. `assertPreRegisteredConstants` pins prod against it. */
const AMBER_CUT = 0.2412;
/** The growth split — 0.5, the [0,1] neutral midpoint, i.e. the image of an all-neutral leg under
 *  `computeLegGrowth`. Frozen here for the same reason as `AMBER_CUT`. */
const GROWTH_MID = 0.5;

/** The four quadrant labels, re-typed from `public/market-mode.js` rather than imported. */
const MODE_HI_DAN_HI_GRO = "euphoric distribution";
const MODE_LO_DAN_LO_GRO = "calm accumulation";
const MODE_LO_DAN_HI_GRO = "healthy markup";
const MODE_HI_DAN_LO_GRO = "risk-off markdown";
const MODES = [MODE_HI_DAN_HI_GRO, MODE_LO_DAN_LO_GRO, MODE_LO_DAN_HI_GRO, MODE_HI_DAN_LO_GRO] as const;
/** The unscored baseline bucket — a leg-day that resolved no live growth. */
const ABSENT = "ABSENT";

/**
 * The pre-registration's own falsifier. It CAN fail: every literal below is a live production
 * constant that a retune moves, and this study is explicitly not reproducible across one.
 * Throwing is the correct outcome — a moved constant means RE-REGISTER, never re-quote.
 */
export function assertPreRegisteredConstants(servedAmber: number, minEpisodes: number): void {
  const drift: string[] = [];
  if (servedAmber !== AMBER_CUT) drift.push(`DANGER_CUTS.amber is ${servedAmber}, the study registered ${AMBER_CUT}`);
  if (minEpisodes !== 30) drift.push(`MIN_EPISODES is ${minEpisodes}, §E-3 registered 30`);
  if (drift.length > 0) {
    throw new Error(
      `[g4-mode-study] the pre-registered constants have MOVED: ${drift.join("; ")}. This study's labels were ` +
        `recomputed under the registered values, so a run under the new ones is a DIFFERENT study — ` +
        `re-register the bar before reading any number below.`,
    );
  }
}

/**
 * The SHIPPED market-mode rule, re-implemented (§E-1). Mirrors `marketMode()` in
 * `public/market-mode.js`: `hiDan = danger ≥ served amber cut`, `hiGro = growth ≥ 0.5`.
 * Returns `null` — i.e. ABSENT — when growth is not live/finite, exactly as the display seam does.
 */
export function modeLabel(danger: number, growth: number | null): string | null {
  if (growth === null || !Number.isFinite(growth) || !Number.isFinite(danger)) return null;
  const hiDan = danger >= AMBER_CUT;
  const hiGro = growth >= GROWTH_MID;
  if (hiDan) return hiGro ? MODE_HI_DAN_HI_GRO : MODE_HI_DAN_LO_GRO;
  return hiGro ? MODE_LO_DAN_HI_GRO : MODE_LO_DAN_LO_GRO;
}

// ---------- args ----------
/** ~10 trading years — deeper than the binding leg's usable growth history (Health/Staples start
 *  2016-04), so the DB's own depth is the constraint, not this cap. */
const REPLAY_N = Number(argOf("closes") ?? 2600);
const outArg = argOf("out");

/** Rows per leg handed to `computeLegRs`, mirroring what `/lab` fetches
 *  (`Y1_MIN_OBS + Y1_PERSIST + Y1_SERIES_PAD`, `src/lab-overlays.ts`) so the reconstruction sees the same
 *  window prod's own call sees. `Y1_SERIES_PAD` is module-private there; 40 is re-typed. */
const LEG_WINDOW = Y1_MIN_OBS + Y1_PERSIST + 40;

// ---------- data pull (READ-ONLY) ----------
const store = getStore("ro", env);
const dialMemberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const legIds = LADDER.map((s) => legCloseId(s));
const seriesById = await loadSeries(store, [...new Set([...dialMemberIds, ...legIds])], 20_000);

assertPreRegisteredConstants(DANGER_CUTS.amber, MIN_EPISODES);

// The label axis is a LEG calendar (S&P 500 closes) — labels are per-leg-day and the harness aligns
// each label date onto that leg's own fixture, so anchoring on a leg calendar keeps the alignment
// exact rather than mapping a macro-feed date forward onto the next leg observation.
const calendar = calendarFrom(seriesById, legCloseId("S&P 500"));
if (calendar.length === 0) throw new Error("[g4-mode-study] LEGP_SPX is empty — nothing to replay (check .env.prod)");
// SEAM: deliberately NOT `selectReplayDates` — its 30-close warm-up margin and three aborts are a
// no-silent-truncation contract for probes whose window is a choice. Here the leg calendar's own
// depth IS the intended constraint (see `REPLAY_N`'s docblock), so that guard would abort the study
// on exactly the shape it is designed to measure. Plain slice, as before.
const replayDates = calendar.slice(-REPLAY_N);

// ---------- per-close reconstruction ----------
/** Index of the last leg observation on or before `d` (ascending series, monotone cursor). */
const legPtr = new Map<Sleeve, number>();
function legWindow(sleeve: Sleeve, d: string): SeriesPoint[] {
  const pts = seriesById.get(legCloseId(sleeve)) ?? [];
  let i = legPtr.get(sleeve) ?? -1;
  while (i + 1 < pts.length && pts[i + 1]!.date <= d) i++;
  legPtr.set(sleeve, i);
  if (i < 0) return [];
  return pts.slice(Math.max(0, i + 1 - LEG_WINDOW), i + 1);
}

const labelsByLeg = new Map<Leg, LabelPoint[]>(LADDER.map((l) => [l, [] as LabelPoint[]]));
let liveGrowthCells = 0;
let totalCells = 0;

// Fold state is genuinely `null`: this walk accumulates into `labelsByLeg` and slices a second,
// per-leg window through its own `legPtr` cursor — there is no per-close prior to thread.
await walkReplay<null>({
  dates: replayDates,
  seriesById,
  ids: dialMemberIds,
  initial: null,
  onClose: ({ date: d, readings }) => {
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
    const dial = computeT1Dial(panel.families, techConfirmerBreadth(techConfirmerFromPanel(panel.families)));

    const legSeries = new Map<Sleeve, SeriesPoint[]>();
    for (const s of LADDER) legSeries.set(s, legWindow(s, d));
    const rs = new Map<string, number | null>([...computeLegRs(legSeries).rs]);
    const mom = new Map<string, number | null>([...computeVolAdjMom(legSeries).mom]);

    const field = computeField({ globalFamilies: panel.families }, dial.band, undefined, null, undefined, rs, mom);
    const byLeg = new Map<string, LegRow>(field.legRows.map((l) => [l.sleeve, l]));
    for (const leg of LADDER) {
      totalCells++;
      const row = byLeg.get(leg);
      const growth = row?.growth?.live ? Number(row.growth.value) : null;
      if (growth !== null) liveGrowthCells++;
      const label = row === undefined ? null : modeLabel(row.danger, growth);
      labelsByLeg.get(leg)!.push({ date: d, bucket: label ?? ABSENT });
    }
    return null;
  },
});

// ---------- the study, one spec per leg ----------
// The nine label series share ONE date axis by construction, so rotation arm `k` is the same
// permutation for every leg — that is what makes the cross-leg pooled statistic below joint rather
// than nine unrelated shuffles. Asserted, not assumed.
const nObs = labelsByLeg.get(LADDER[0])!.length;
for (const leg of LADDER) {
  const n = labelsByLeg.get(leg)!.length;
  if (n !== nObs) {
    throw new Error(
      `[g4-mode-study] leg ${leg} has ${n} labels but ${LADDER[0]} has ${nObs} — the rotation arms would not ` +
        `align across legs and the pooled permutation p would be meaningless.`,
    );
  }
}

const legFixture = Object.fromEntries(LADDER.map((l) => [l, `${OUT_DIR_REL}/${legCloseId(l)}.csv`])) as Partial<
  Record<Leg, string>
>;
const legEvidence = Object.fromEntries(LADDER.map((l) => [l, "EXACT" as const])) as Partial<
  Record<Leg, "EXACT">
>;

const rows: EventStudyRow[] = [];
for (const leg of LADDER) {
  rows.push(
    ...runEventStudy({
      label: `G4 market mode — ${leg}`,
      cadence: "daily",
      labels: labelsByLeg.get(leg)!,
      baselineBucket: ABSENT,
      legs: [leg],
      legFixture,
      legEvidence,
      placeboRotations: PLACEBO_ROTATIONS,
    }),
  );
}

// ---------- pooled statistic + verdict ----------
interface Pooled {
  horizon: number;
  /** mean excess per mode, over the legs whose cell cleared `MIN_EPISODES` */
  byMode: Map<string, { meanPp: number; legs: number }>;
  best: string;
  worst: string;
  spreadPp: number;
  p: number;
  thinReason: string | null;
}

/**
 * Does `challenger` beat `incumbent` under `dir`, with non-finite values screened OUT?
 * A finite value always beats a non-finite one; two non-finite values never displace each other, so a
 * mode with no usable cell can never be reported as best or worst while any mode has a finite mean.
 */
function better(challenger: number, incumbent: number, dir: "max" | "min"): boolean {
  if (!Number.isFinite(challenger)) return false;
  if (!Number.isFinite(incumbent)) return true;
  return dir === "max" ? challenger > incumbent : challenger < incumbent;
}

function pooledAt(horizon: number): Pooled {
  const byMode = new Map<string, { meanPp: number; legs: number }>();
  // arm-indexed spreads: index 0 is placebo arm 0, … — one entry per rotation, joint across legs.
  const armModeSums = new Map<string, number[]>();
  const armModeCounts = new Map<string, number[]>();
  let arms = -1;
  const thin: string[] = [];

  for (const mode of MODES) {
    const cells = rows.filter((r) => r.horizon === horizon && r.bucket === mode);
    const usable = cells.filter((c) => c.nEpisodes >= MIN_EPISODES && Number.isFinite(c.excessPp));
    byMode.set(mode, {
      meanPp: usable.length === 0 ? NaN : usable.reduce((a, c) => a + c.excessPp, 0) / usable.length,
      legs: usable.length,
    });
    if (usable.length < MIN_LEGS_PER_MODE) {
      thin.push(`${mode}: ${usable.length}/${LADDER.length} legs cleared MIN_EPISODES=${MIN_EPISODES}`);
    }
    for (const c of usable) {
      if (arms === -1) arms = c.placeboExcessPp.length;
      const sums = armModeSums.get(mode) ?? new Array<number>(arms).fill(0);
      const counts = armModeCounts.get(mode) ?? new Array<number>(arms).fill(0);
      for (let a = 0; a < arms; a++) {
        const v = c.placeboExcessPp[a]!;
        if (Number.isFinite(v)) {
          sums[a] = sums[a]! + v;
          counts[a] = counts[a]! + 1;
        }
      }
      armModeSums.set(mode, sums);
      armModeCounts.set(mode, counts);
    }
  }

  const realMeans = MODES.map((m) => byMode.get(m)!.meanPp).filter((v) => Number.isFinite(v));
  // A mode with no usable cell has `meanPp === NaN`. `||`/`??` do NOT screen that (`??` passes NaN
  // through, and every comparison against NaN is false), so a non-finite MODES[0] would survive both
  // reduces and be printed as best AND worst while `spreadPp` — which filters to finite means — quotes
  // a spread computed from entirely different modes. Screen explicitly, and let a non-finite seed lose
  // to any finite challenger.
  const meanOf = (m: string): number => byMode.get(m)!.meanPp;
  const best = MODES.reduce((b, m) => (better(meanOf(m), meanOf(b), "max") ? m : b));
  const worst = MODES.reduce((b, m) => (better(meanOf(m), meanOf(b), "min") ? m : b));
  const spreadPp = realMeans.length < 2 ? NaN : Math.max(...realMeans) - Math.min(...realMeans);

  const armSpreads: number[] = [];
  for (let a = 0; a < Math.max(arms, 0); a++) {
    const vals: number[] = [];
    for (const mode of MODES) {
      const s = armModeSums.get(mode);
      const c = armModeCounts.get(mode);
      if (s && c && c[a]! > 0) vals.push(s[a]! / c[a]!);
    }
    armSpreads.push(vals.length < 2 ? NaN : Math.max(...vals) - Math.min(...vals));
  }
  return {
    horizon,
    byMode,
    best,
    worst,
    spreadPp,
    p: permutationP(spreadPp, armSpreads),
    thinReason: thin.length > 0 ? thin.join(" · ") : null,
  };
}

const pooled = HORIZONS_TD.map(pooledAt);

// ---------- report ----------
console.log(`=== G4 market-mode placebo event study — PROD, read-only ===`);
console.log(`label axis   ${replayDates[0]} → ${replayDates.at(-1)}  (${nObs} closes × ${LADDER.length} legs)`);
console.log(`growth live  ${liveGrowthCells} of ${totalCells} (close, leg) cells — the rest are ABSENT, never calm`);
console.log(
  `pre-registered  rotations=${PLACEBO_ROTATIONS} · p ≤ ${P_MAX} · spread ≥ ${SPREAD_FLOOR_PP.toFixed(1)}pp at BOTH ` +
    `${HORIZONS_TD.join("/")}d · MIN_EPISODES=${MIN_EPISODES} · ≥${MIN_LEGS_PER_MODE}/9 legs per mode`,
);

console.log(`\n--- per-mode episode counts (contiguous label runs), by leg ---`);
console.log(`${"mode".padEnd(24)}${LADDER.map((l) => l.padStart(9)).join("")}`);
for (const mode of MODES) {
  const counts = LADDER.map((leg) => {
    const c = rows.find((r) => r.bucket === mode && r.leg === leg);
    return String(c?.nEpisodes ?? 0).padStart(9);
  });
  console.log(`${mode.padEnd(24)}${counts.join("")}`);
}

for (const pv of pooled) {
  console.log(`\n--- pooled cross-leg forward excess @${pv.horizon}d ---`);
  for (const mode of MODES) {
    const m = pv.byMode.get(mode)!;
    console.log(
      `  ${mode.padEnd(24)}${(Number.isFinite(m.meanPp) ? m.meanPp.toFixed(2) : "—").padStart(9)}pp   ` +
        `(${m.legs}/${LADDER.length} legs)`,
    );
  }
  console.log(
    `  spread (best−worst)  ${(Number.isFinite(pv.spreadPp) ? pv.spreadPp.toFixed(2) : "—").padStart(6)}pp` +
      `   best=${pv.best}  worst=${pv.worst}   permutation p = ${Number.isFinite(pv.p) ? pv.p.toFixed(3) : "—"}`,
  );
  if (pv.thinReason) console.log(`  THIN: ${pv.thinReason}`);
}

const thin = pooled.some((p) => p.thinReason !== null || !Number.isFinite(p.spreadPp));
const clearsFloor = pooled.every((p) => p.spreadPp >= SPREAD_FLOOR_PP);
const clearsP = pooled.every((p) => p.p <= P_MAX);
const verdict = thin ? "THIN" : clearsFloor && clearsP ? "PASS" : "FAIL";

console.log(`\n=== VERDICT: ${verdict} ===`);
console.log(
  `  spread ≥ ${SPREAD_FLOOR_PP}pp at both horizons: ${clearsFloor ? "yes" : "NO"}  ·  ` +
    `p ≤ ${P_MAX} at both horizons: ${clearsP ? "yes" : "NO"}  ·  thin guard: ${thin ? "TRIPPED" : "clear"}`,
);
if (verdict !== "PASS") {
  console.log(
    `  A null on a thin sample is a null, not a licence to widen the bar (D6). The pre-registered numbers ` +
      `above were fixed before this run and are not moved by it.`,
  );
}
console.log(
  `\n  This answers "did the mode label predict the leg's own forward return", NOT the ACWI-relative\n` +
    `  rotation question (D19). Labels were recomputed under today's constants — not reproducible\n` +
    `  across a later retune (see the file docblock).`,
);

if (outArg) {
  writeFileSync(outArg, JSON.stringify({ verdict, pooled: pooled.map((p) => ({ ...p, byMode: [...p.byMode] })), rows }, null, 2));
  console.log(`\nwrote → ${outArg}`);
}
