/**
 * probe-danger-cut-percentile.ts — where DANGER_CUTS sit in the pooled per-leg danger. READ-ONLY.
 *
 * QUANTITY MEASURED: the worst-of per-leg `danger` (`computeField(...).legRows[].danger`, the scalar
 * `run-core.ts` pushes and `DANGER_CUTS` bands) — NOT the per-super-group pillar values stage1c reports.
 * Pools every leg-close over the last N closes and reports the distribution, the percentile each live
 * cut (READ from `DANGER_CUTS`, never restated — `indicator-loop.md` §A retune is a ONE-place edit) occupies, the
 * GREEN/AMBER/RED band share, and each leg's peak danger + date (Stage 2.4: does S&P IT read exactly
 * `DANGER_CUTS.red` on the docblock's named close?).
 *
 * The engine is IMPORTED, never reimplemented: only the per-close panel reconstruction
 * (forward-fill → computeFamilyPanel → computeT1Dial → computeField) is mirrored, off replay-walk.ts.
 * Dial band reduces against DIAL_FAMILIES (not GLOBAL_FAMILIES); the pooled danger is band-independent,
 * so this touches only the (unused-here) band argument.
 *
 * STRICTLY READ-ONLY: getSeries selects only — never insert/update/delete/upsert.
 *
 * Usage (env -u is required — a local SUPABASE_URL makes resolveStore refuse --env=prod):
 *   env -u SUPABASE_URL -u SUPABASE_SERVICE_KEY bash scripts/with-prod-config.sh --optional tsx \
 *     scripts/probe-danger-cut-percentile.ts --closes=365 --env=prod
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { US_FAMILIES, GLOBAL_FAMILIES, computeFamilyPanel } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth } from "../src/t1dial.js";
import { computeField, pillarValue, type MemberHistoryEntry } from "../src/danger-engine.js";
import { trendGateFactor } from "../src/danger-share.js";
import { DANGER_CUTS } from "../src/danger-concentration.js";
import { LEG_FIELD } from "../src/danger-ladder.js";
import { rollingEcdfRank, ECDF_WINDOW } from "../src/leg-percentile.js";
import { DOWNSIDE_DETECTOR_IDS } from "../src/registry-price.js";
import type { State } from "../src/domain-types.js";
import { argOf, envArgStrict } from "./lib/cli.js";
import { loadSeries, calendarFrom, makeCursor, selectReplayDates, MEMBER_WINDOW } from "./lib/replay-walk.js";

// ---------- args ----------
const REPLAY_N = Number(argOf("closes") ?? 365);
const envArg = envArgStrict("prod");

const store = await resolveStore(envArg, "ro", liveResolveDeps);

// ---------- data pull (read-only) ----------
const memberIds = [...new Set([...US_FAMILIES, ...GLOBAL_FAMILIES].flatMap((f) => f.ids))];
const DB_IDS = DOWNSIDE_DETECTOR_IDS; // tech-confirmer inputs for the dial band
const seriesById = await loadSeries(store, [...memberIds, ...DB_IDS], REPLAY_N + MEMBER_WINDOW + 200);
const calendar = calendarFrom(seriesById);
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N });
const advance = makeCursor(seriesById);
const HIST_TAIL = MEMBER_WINDOW + 8;

// ---------- replay: pool leg-close danger straight off computeField ----------
interface Sample {
  leg: string;
  danger: number;
  date: string;
  /** §5d decomposition: the share terms `danger` takes the worst-of; `gp` is not per-row, so it is
   *  INFERRED as "no other term equals `danger`". */
  ew: number | null;
  sn: number | null;
  trend: number | null;
  trendCounting: boolean;
}
const samples: Sample[] = [];

for (const d of replayDates) {
  const readings: { id: string; state: State }[] = [];
  const history: MemberHistoryEntry[] = [];
  for (const id of memberIds) {
    const i = advance(id, d);
    if (i < 0) continue;
    const pts = seriesById.get(id)!;
    readings.push({ id, state: pts[i]!.state });
    history.push({ id, history: pts.slice(Math.max(0, i + 1 - HIST_TAIL), i + 1) });
  }
  // DIAL_FAMILIES fold for the band (B-11, mirrors stage1c) — the pooled danger below is band-independent.
  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const dbStates = DB_IDS.map((id) => {
    const i = advance(id, d);
    return i < 0 ? null : seriesById.get(id)![i]!.state;
  });
  const dial = computeT1Dial(panel.families, techConfirmerBreadth(dbStates));
  // THE SHIPPED ENTRY POINT — same call shape run-core.ts pushes on; no probe arm, no momentum inputs
  // (undefined rs/mom, prevTarget null, no freshness — matching probe-leg-ordering's severity-neutral walk).
  const field = computeField(
    { globalFamilies: panel.families },
    dial.band,
    undefined,
    null,
    history,
    undefined,
    undefined,
    undefined,
    dial.targetRung,
  );
  for (const r of field.legRows)
    samples.push({
      leg: r.sleeve,
      danger: r.danger,
      date: d,
      ew: pillarValue(r.subDangers.earlyWarn),
      sn: pillarValue(r.subDangers.stressNow),
      trend: r.trend.value,
      trendCounting: r.trend.counting,
    });
}

// ---------- report helpers ----------
const QS = [0.5, 0.75, 0.9, 0.95, 0.99, 1];
const qtile = (arr: readonly number[], q: number): number => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]!;
};
/** percentile RANK of `v` within `arr` as a 0–1 fraction: share of samples <= v. */
const pctRank = (arr: readonly number[], v: number): number =>
  arr.length ? arr.filter((x) => x <= v).length / arr.length : NaN;
const fmtQ = (a: readonly number[]): string => QS.map((q) => qtile(a, q).toFixed(4)).join(" / ");
/** FE `bandClass` (public/sub-dangers.js): r if v>=red, a if v>=amber, else g. */
const bandOf = (v: number): "g" | "a" | "r" =>
  v >= DANGER_CUTS.red ? "r" : v >= DANGER_CUTS.amber ? "a" : "g";

const legs = LEG_FIELD.map((l) => l.sleeve);
const pooled = samples.map((s) => s.danger);

const byLeg = new Map<string, number[]>(legs.map((l) => [l, []]));
for (const s of samples) byLeg.get(s.leg)!.push(s.danger);

console.log(
  `\n== probe-danger-cut-percentile (${envArg}) — pooled per-leg danger over ${replayDates.length} closes ` +
    `x ${legs.length} legs; ${replayDates[0]} → ${replayDates.at(-1)} ==`,
);
console.log(`   quantity = computeField().legRows[].danger (the scalar DANGER_CUTS bands)`);
console.log(`   live cuts (from DANGER_CUTS): amber=${DANGER_CUTS.amber}  red=${DANGER_CUTS.red}`);

// ---------- 1. distribution ----------
console.log(`\n-- 1. Distribution (p50/p75/p90/p95/p99/max) --`);
console.log(`pooled (n=${pooled.length}): ${fmtQ(pooled)}`);
for (const l of legs) {
  const a = byLeg.get(l)!;
  console.log(`  ${l.padEnd(8)} (n=${a.length}): ${fmtQ(a)}`);
}

// ---------- 2. where the live cuts sit ----------
console.log(`\n-- 2. Percentile rank of each live cut in the pooled distribution --`);
const pAmber = pctRank(pooled, DANGER_CUTS.amber);
const pRed = pctRank(pooled, DANGER_CUTS.red);
console.log(`amber ${DANGER_CUTS.amber} → ${(100 * pAmber).toFixed(2)} pctile`);
console.log(`red   ${DANGER_CUTS.red} → ${(100 * pRed).toFixed(2)} pctile`);

// ---------- 3. band share ----------
console.log(`\n-- 3. Band share under the live cuts (r: v>=red, a: v>=amber, g: else) --`);
const tally = (arr: readonly number[]): { g: number; a: number; r: number } => {
  const t = { g: 0, a: 0, r: 0 };
  for (const v of arr) t[bandOf(v)]++;
  return t;
};
const pct = (n: number, d: number): string => (d ? ((100 * n) / d).toFixed(2) : "0.00");
const pt = tally(pooled);
const pn = pooled.length;
console.log(
  `pooled (n=${pn}): GREEN ${pt.g} (${pct(pt.g, pn)}%)  AMBER ${pt.a} (${pct(pt.a, pn)}%)  ` +
    `RED ${pt.r} (${pct(pt.r, pn)}%)  [sum ${pct(pt.g + pt.a + pt.r, pn)}%]`,
);
for (const l of legs) {
  const a = byLeg.get(l)!;
  const t = tally(a);
  console.log(
    `  ${l.padEnd(8)} (n=${a.length}): G ${t.g} (${pct(t.g, a.length)}%)  ` +
      `A ${t.a} (${pct(t.a, a.length)}%)  R ${t.r} (${pct(t.r, a.length)}%)`,
  );
}

// ---------- 4. window maxima + the red/amber atoms (Stage 2.4) ----------
// 4a. per-leg window MAX + date — a distribution extreme, NOT the docblock's atom claim.
console.log(`\n-- 4a. Per-leg window MAX danger + date (distribution extreme, not the atom claim) --`);
for (const l of legs) {
  const rows = samples.filter((s) => s.leg === l);
  const peak = rows.reduce((m, s) => (s.danger > m.danger ? s : m), rows[0]!);
  console.log(`  ${l.padEnd(8)}: max ${peak.danger.toFixed(6)} (raw ${peak.danger}) on ${peak.date}`);
}

// 4b. the docblock's NAMED peak close. `danger-concentration.ts`'s ⚠ claims S&P IT reads exactly the
// red cut here — a PROVENANCE date read out of the walked samples, not a --asOf anchor.
const ATOM_CLOSE = "2025-06-05";
const onDate = (leg: string, date: string): number | undefined =>
  samples.find((s) => s.leg === leg && s.date === date)?.danger;
const walked = replayDates.includes(ATOM_CLOSE);
console.log(`\n-- 4b. Value on the docblock's named peak close (${ATOM_CLOSE}) --`);
if (walked) {
  for (const l of legs) {
    const v = onDate(l, ATOM_CLOSE) ?? NaN;
    const tag = v === DANGER_CUTS.red ? "  <-- == red exactly" : v === DANGER_CUTS.amber ? "  <-- == amber exactly" : "";
    console.log(`  ${l.padEnd(8)}: ${v.toFixed(6)} (raw ${v})${tag}`);
  }
} else {
  const before = [...replayDates].filter((dt) => dt < ATOM_CLOSE).at(-1);
  const after = [...replayDates].filter((dt) => dt > ATOM_CLOSE)[0];
  console.log(`  NO close on ${ATOM_CLOSE} in the walked window — nearest on either side (S&P IT):`);
  for (const [label, dt] of [["before", before], ["after", after]] as const) {
    if (dt === undefined) { console.log(`    ${label}: (none)`); continue; }
    const v = onDate("S&P IT", dt) ?? NaN;
    console.log(`    ${label} ${dt}: S&P IT ${v.toFixed(6)} (raw ${v})`);
  }
}

// 4c. ATOM PROBE — every close where a leg's danger equals a cut EXACTLY, whole window, all legs.
// Establishes whether each live cut lands ON a data point, DIRECTLY — never inferred from one maximum.
console.log(`\n-- 4c. Atom probe: closes where danger == a cut EXACTLY (whole window, per leg) --`);
for (const cutName of ["red", "amber"] as const) {
  const cut = DANGER_CUTS[cutName];
  console.log(`  == ${cutName} (${cut}) ==`);
  let total = 0;
  for (const l of legs) {
    const hits = samples.filter((s) => s.leg === l && s.danger === cut).map((s) => s.date);
    total += hits.length;
    if (hits.length) console.log(`    ${l.padEnd(8)}: ${hits.length} close(s) — ${hits.join(", ")}`);
  }
  console.log(
    `    TOTAL leg-closes exactly == ${cutName}: ${total}` +
      (total === 0 ? "  (cut lands on NO data point in this window)" : ""),
  );
}

// Verdict answers the docblock's ACTUAL claim — S&P IT == red ON 2025-06-05 — never the window max.
const spOnAtom = walked ? (onDate("S&P IT", ATOM_CLOSE) ?? NaN) : undefined;
console.log(
  `\nStage 2.4 verdict (S&P IT danger ON ${ATOM_CLOSE} vs red=${DANGER_CUTS.red}): ` +
    (!walked
      ? `NO close on ${ATOM_CLOSE} in window — claim untestable at the exact date here; see 4b nearest closes.`
      : spOnAtom === DANGER_CUTS.red
        ? `${spOnAtom} == red EXACTLY — atom CONFIRMED.`
        : `${spOnAtom} != red — atom REFUTED (the docblock ⚠ claims an exact match on this close).`),
);

// ---------- 5. Stage M (CDF plan): ceiling mass + per-leg rank transform ----------
// Feeds the [USER] cut ruling on the TRANSFORMED scale.
// Rank convention MIRRORS the shipped `/lab` path (`api/lab.ts`): history
// is the STRICTLY PRIOR closes, the live value is ranked against them, `rollingEcdfRank` owns the
// window + tie rule. No candidate cut is pre-picked — the grid below reports shares, never a choice.
const CEIL = 1;
console.log(`\n-- 5a. Ceiling mass: closes at exactly ${CEIL.toFixed(4)} (raw danger) --`);
for (const l of legs) {
  const a = byLeg.get(l)!;
  const n1 = a.filter((v) => v === CEIL).length;
  console.log(`  ${l.padEnd(8)}: ${n1}/${a.length} (${pct(n1, a.length)}%)  max ${qtile(a, 1).toFixed(6)}`);
}

// Per-leg date-ordered danger, then the rolling rank of each close against its own prior window.
const RANK_QS = [0.5, 0.75, 0.9, 0.95, 0.99, 1];
const ranksByLeg = new Map<string, number[]>();
let warmupTotal = 0;
for (const l of legs) {
  const series = samples.filter((s) => s.leg === l).sort((x, y) => (x.date < y.date ? -1 : 1));
  const ranks: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const r = rollingEcdfRank(series.slice(0, i).map((s) => s.danger), series[i]!.danger);
    if (r.kind === "warmup") warmupTotal++;
    else ranks.push(r.value);
  }
  ranksByLeg.set(l, ranks);
}
console.log(
  `\n-- 5b. Rank-transformed distribution (rolling ECDF_WINDOW=${ECDF_WINDOW}, prior-close history) --`,
);
console.log(
  `   warmup leg-closes (history < ECDF_WINDOW): ${warmupTotal}/${samples.length}` +
    (warmupTotal === samples.length
      ? `  <-- ALL warmup: re-run with --closes>=${ECDF_WINDOW + 250} or 5b/5c say nothing`
      : ""),
);
for (const l of legs) {
  const a = ranksByLeg.get(l)!;
  const atOne = a.filter((v) => v === 1).length;
  console.log(
    `  ${l.padEnd(8)} (ranked n=${a.length}): ` +
      (a.length === 0
        ? "— all warmup"
        : `${RANK_QS.map((q) => qtile(a, q).toFixed(4)).join(" / ")}   rank==1.0000 on ${atOne} (${pct(atOne, a.length)}%)`),
  );
}

// 5c. Candidate-cut GRID on the transformed scale — shares only. The ruling is [USER]-owned (IS-3).
const CAND_CUTS = [0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 0.99] as const;
console.log(`\n-- 5c. Share of ranked leg-closes >= each candidate cut (transformed scale; NO cut picked) --`);
console.log(`  ${"leg".padEnd(8)}  ${CAND_CUTS.map((c) => c.toFixed(2).padStart(6)).join(" ")}`);
for (const l of legs) {
  const a = ranksByLeg.get(l)!;
  const row = CAND_CUTS.map((c) =>
    (a.length ? pct(a.filter((v) => v >= c).length, a.length) : "—").padStart(6),
  ).join(" ");
  console.log(`  ${l.padEnd(8)}  ${row}`);
}
const pooledRanks = legs.flatMap((l) => ranksByLeg.get(l)!);
console.log(
  `  ${"POOLED".padEnd(8)}  ` +
    CAND_CUTS.map((c) =>
      (pooledRanks.length ? pct(pooledRanks.filter((v) => v >= c).length, pooledRanks.length) : "—").padStart(6),
    ).join(" "),
);

// ---------- 5d. Which term pins a saturated leg at the ceiling? ----------
// Share danger = max(ew, sn, uT × trendGateFactor(ew, sn), gp) (`danger-share.ts`); gp has no per-row field, so inferred.
console.log(`\n-- 5d. Ceiling decomposition: which share term == danger on a pinned close --`);
for (const l of legs) {
  const pinned = samples.filter((s) => s.leg === l && s.danger === CEIL);
  if (pinned.length === 0) continue;
  const tally = { ew: 0, sn: 0, gatedTrend: 0, "gp(inferred)": 0 } as Record<string, number>;
  for (const s of pinned) {
    const gt = s.trend != null ? s.trend * trendGateFactor(s.ew ?? 0, s.sn ?? 0) : null;
    if (s.ew === s.danger) tally.ew!++;
    else if (s.sn === s.danger) tally.sn!++;
    else if (gt === s.danger) tally.gatedTrend!++;
    else tally["gp(inferred)"]!++;
  }
  console.log(
    `  ${l.padEnd(8)} (${pinned.length} pinned closes): ` +
      Object.entries(tally).map(([k, v]) => `${k}=${v}`).join("  "),
  );
  const first = pinned[0]!;
  const last = pinned.at(-1)!;
  for (const s of [first, last])
    console.log(
      `    ${s.date}: ew=${s.ew} sn=${s.sn} trend=${s.trend} (counting=${s.trendCounting}) danger=${s.danger}`,
    );
}
