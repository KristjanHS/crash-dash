/**
 * Read-only PROD probe: how much do the six E6(b) candidate duplicate-groups actually OVERLAP?
 * Written 2026-07-30 for the E6(b) duplicate audit's Stage 5,
 * whose deliverable may not ship a
 * "these are duplicates" verdict that is not backed by a measurement.
 *
 *     bash scripts/with-prod-config.sh tsx scripts/probe-e6b-overlap.ts        # reads the prod config, WRITES NOTHING
 *
 * ⚠ **PROD, not dev** (`research-probes.md` §The instrument is a claim too): the dev DB has no cron, so its recency and its
 * per-indicator coverage are stale by construction and an overlap measured there would be an
 * artifact of when someone last ran a backfill.
 *
 * WHAT IS CORRELATED — three DIFFERENT claims, printed separately because they are not
 * interchangeable and a doc quoting one under the other's name would be wrong:
 *   • `r(level)` — Pearson over the stored `value` column, i.e. the indicator's own axis as
 *     persisted by the cron (a ratio for F5/F6/SPCONC, a yield for R2/R3/R4, an index level for
 *     R5/OVX/BRENT). Two series can share a level trend and never co-fire.
 *   • `r(Δ20)`   — Pearson over the stored `delta20` column (the 20-close velocity production
 *     scores the velocity legs on). This is the project's SAME-FACTOR metric (`probe-bund-eurc.ts`
 *     §3.2 line, r ≥ 0.90 ⇒ one factor), restated by `archive/probe-r2-r4.ts` / `probe-move-vix.ts`.
 *   • `r(state)` — Pearson over the CONFIRMED state mapped to grid severity (GREEN 0 / AMBER 0.5 /
 *     RED 1), plus the co-firing table beside it. This is the only one that speaks about the days
 *     the dashboard actually reacts on; the two above are axis claims.
 * A group whose members share an axis but not a firing pattern is NOT a duplicate, and vice versa.
 *
 * ⚠ **STORED SERIES, NOT A RE-SCORE.** Every number here comes off `readings_latest` through
 * `store.getSeries` — the same rows `/api/series` serves. Nothing is re-scored, no cut is
 * re-implemented, so a cut retune between the stored rows and HEAD would show up here as history,
 * which is the honest reading for an "are these two rows redundant on the record" question.
 * The counterpart offline instruments that DO re-run the production chain are `archive/probe-r2-r4.ts`
 * (R2/R4) and `probe-move-vix.ts` (R5/R6); this probe deliberately measures the OTHER thing.
 *
 * GUARDS (each can exit non-zero — see the CAN-FIRE DEMOs at the bottom of this block):
 *   G1 ALIASING — two ids whose joined `value` vectors are byte-identical over the shared window
 *      are the same stored series read twice (an id typo, or a genuine write-path duplication).
 *      Every correlation would then be a tautology, so it THROWS instead of printing 1.0000.
 *   G2 NON-VACUITY — if NO pair in the whole run clears `MIN_OBS` overlapping observations, the
 *      run measured nothing and THROWS rather than emitting a page of `UNMEASURED` that could be
 *      mistaken for a result.
 *   G3 EMPTY READ — an id the roster names but prod has zero rows for is reported explicitly
 *      (it makes every pair it belongs to `UNMEASURED`, never silently absent).
 * A pair below `MIN_OBS` is printed `UNMEASURED` and carries no verdict — that is the required
 * outcome for "cannot be measured", not a guessed correlation.
 *
 * CAN-FIRE DEMO — re-run against prod 2026-07-30, stderr quoted VERBATIM, both mutations restored
 * by re-typing (never `git checkout --`):
 *   • aliasing `SPCONC` to `F5` inside `GROUPS` throws, exit 1:
 *     `Error: [probe-e6b-overlap] F5 vs F5: the two stored value vectors are byte-identical over all`
 *     `3358 shared days 2013-03-22 → 2026-07-29. That is one series read under two ids (id typo, or a`
 *     `duplicated write path) — every correlation below would be a tautology. Fix the ids before`
 *     `reading any number.`
 *   • raising `MIN_OBS` to 100000 throws, exit 1:
 *     `Error: [probe-e6b-overlap] not one of the 14 pairs cleared MIN_OBS=100000 overlapping`
 *     `observations, so this run measured nothing at all. Check the DB target (.env.prod) and the`
 *     `stored-row inventory above before quoting any line of this output.`
 *   (14, not 12: `GROUPS` yields 3+1+3+1+3+3 pairs. The count is printed, not hand-typed.)
 *
 * ─── `--aliasing-all` MODE (2026-08-31, the §0.3 guard of
 * the R6 db-first cron) ───────────────────────────────────────────────
 *
 *     npm run probe:e6b-aliasing       # = --aliasing-all; reads .env.prod, WRITES NOTHING
 *
 * The default mode above only checks G1 inside its fixed `GROUPS` roster. This mode proves NO two ids
 * WIRED DB-FIRST hold the same underlying series before the cron scores off stored history — two such
 * ids could diverge under the 14-day tail-merge. The guard is SCOPED, not allowlisted: it governs
 * exactly the db-first roster (`DB_FIRST_IDS`, `probe-db-first-rollout.ts`) with no per-pair
 * exemptions; an id not wired db-first is OUT OF SCOPE, not exempted
 * (RULED). R1=R7 and the other stored-value coincidences stay
 * off this guard because the db-first path never reads R7's stored `value` — R7's legs resolve through
 * `R7_LEG_IDS = [R1, R3, R2]`. This mode:
 *   1. takes the db-first roster from `DB_FIRST_IDS` (a new db-first site joins the guard by being
 *      added there — no hand-list here to drift out of sync);
 *   2. reads each through `store.getSeriesBulk(ids, { limit: ALIASING_LIMIT })` (the served vintage);
 *   3. for every pair with ≥ `MIN_OBS` shared dates classifies the joined `value` vectors:
 *      IDENTICAL — byte-equal on every shared date ⇒ a duplicate row among db-first ids: collected,
 *        the run EXITS NON-ZERO listing them — §0.3 forbids splicing the db-first cron on top;
 *      NEAR-IDENT — equal to `SCALE_REL_TOL` but not byte-equal ⇒ the same series at two roundings:
 *        a duplicate row, throws like IDENTICAL under the same `ALIASING:` verdict;
 *      SCALED    — a constant non-unit ratio on every shared date (pct-points vs bp, index vs
 *        ×100) ⇒ a WARNING line, not a failure: the same underlying series under a unit change;
 *      AFFINE    — r ≥ `AFFINE_R` but not a constant ratio ⇒ a WARNING line (a derived transform
 *        of another stored series is not a duplicate row).
 *   Nothing else is printed per pair — this mode is a guard, not the correlation study above.
 * It prints one inventory line per id (rows, first → last) and ends `ALIASING: none among N ids /
 * M pairs` or the list. `M` is the count of pairs that CLEARED `MIN_OBS`; a run where M = 0
 * throws (G2, same reasoning as the default mode).
 *
 * CAN-FIRE DEMO: injecting a duplicate among the IN-SCOPE ids — `series.set("__DUP__",
 * series.get(ids[0]!))` before the pairwise loop → `IDENTICAL <id0> vs __DUP__`, exit 1; removed by
 * re-typing.
 */
import { getStore, type SeriesPoint } from "../src/store.js";
import { VELOCITY_WINDOW, type State } from "../src/domain-types.js";
import { pct, pearson, sd } from "./lib/stats.js";
import { hasFlag } from "./lib/cli.js";
import { DB_FIRST_IDS } from "./probe-db-first-rollout.js";
import { readEnv, type Env } from "../src/config.js";

/** Newest-N cap per id. Prod history is short of this for every id; it exists so the read is bounded. */
const SERIES_LIMIT = 20000;

/** Below this many shared observations a correlation is noise dressed as evidence ⇒ `UNMEASURED`. */
const MIN_OBS = 60;

/** The project's same-factor line (`probe-bund-eurc.ts` §3.2, restated by `archive/probe-r2-r4.ts`). */
const SAME_FACTOR_R = 0.9;

/** Widest lead/lag scanned on Δ20, in stored trading days. */
const LAG_SPAN = 30;

/** Below this |r| a lead/lag argmax is a noise peak and its `k` is suppressed rather than printed. */
const LL_R_FLOOR = 0.1;

/** Grid severity of a confirmed state — the same GREEN/AMBER/RED → 0/0.5/1 map `archive/probe-r2-r4.ts` uses. */
const SEV: Record<State, number> = { GREEN: 0, AMBER: 0.5, RED: 1 };

interface Group {
  key: string;
  title: string;
  ids: string[];
}

/** The six candidate groups, banked at Stage 5
 *  (live rosters, verified 2026-07-29). */
const GROUPS: Group[] = [
  { key: "rates-velocity", title: "R2 10y Δ / R3 2y Δ / R4 10y TIPS Δ", ids: ["R2", "R3", "R4"] },
  { key: "breakevens", title: "T10YIE 10y breakeven / T5YIFR 5y5y forward", ids: ["T10YIE", "T5YIFR"] },
  { key: "vix-complex", title: "R5 VIX / VT VIX term / complacency-vix", ids: ["R5", "VT", "complacency-vix"] },
  { key: "concentration", title: "F5 QQQ/QQQE / SPCONC SPY/RSP", ids: ["F5", "SPCONC"] },
  { key: "semis", title: "F4 SMH / F6 SOX/SPX / F8 MU", ids: ["F4", "F6", "F8"] },
  { key: "oil", title: "G1 WTI / BRENT / OVX", ids: ["G1", "BRENT", "OVX"] },
];

/** A correlation is only a number when BOTH inputs vary — a constant arm makes it 0/0. */
function rOrNa(a: readonly number[], b: readonly number[], labA: string, labB: string): string {
  const sa = sd(a);
  const sb = sd(b);
  if (sa === 0 && sb === 0) return `n/a (BOTH constant: ${labA}, ${labB})`;
  if (sa === 0) return `n/a (${labA} constant)`;
  if (sb === 0) return `n/a (${labB} constant)`;
  const r = pearson(a, b);
  return r.toFixed(4);
}

/** argmax over k ∈ [−span, +span] of corr(a[t], b[t+k]). POSITIVE k ⇒ `a` LEADS `b`.
 *  `null` when EVERY lag was skipped (each shifted window under `MIN_OBS`, or an arm constant on it):
 *  nothing was measured, and the seed must never be printed as if it were — a sentinel `r = −2` has
 *  |r| ≥ the 0.10 noise floor, so it would dodge the suppressor and print `r=-2.0000` as a result. */
function leadLag(a: readonly number[], b: readonly number[], span: number): { k: number; r: number } | null {
  let best: { k: number; r: number } | null = null;
  for (let k = -span; k <= span; k++) {
    const x = k >= 0 ? a.slice(0, a.length - k) : a.slice(-k);
    const y = k >= 0 ? b.slice(k) : b.slice(0, b.length + k);
    if (x.length < MIN_OBS || sd(x) === 0 || sd(y) === 0) continue;
    const r = pearson(x, y);
    if (best === null || r > best.r) best = { k, r };
  }
  return best;
}

const isLit = (s: State): boolean => s === "AMBER" || s === "RED";

/** One pair's co-firing table over CONFIRMED states — the only arm about days the dial reacts on. */
function coFiring(aS: readonly State[], bS: readonly State[], idA: string, idB: string): string[] {
  const n = aS.length;
  const aF = aS.map(isLit);
  const bF = bS.map(isLit);
  const nA = aF.filter(Boolean).length;
  const nB = bF.filter(Boolean).length;
  const both = aF.filter((v, i) => v && bF[i]).length;
  const union = aF.filter((v, i) => v || bF[i]).length;
  const cond = (num: number, den: number): string => (den === 0 ? "n/a (never lit)" : (num / den).toFixed(3));
  return [
    `    AMBER+ ${idA} ${String(nA).padStart(4)} (${pct(nA / n)})   ${idB} ${String(nB).padStart(4)} (${pct(nB / n)})   BOTH ${String(both).padStart(4)} (${pct(both / n)})`,
    `    ${idA}-only ${String(nA - both).padStart(4)}   ${idB}-only ${String(nB - both).padStart(4)}   ` +
      `Jaccard ${union === 0 ? "n/a (neither ever lit)" : (both / union).toFixed(3)}`,
    `    P(${idB}|${idA}) ${cond(both, nA)}   P(${idA}|${idB}) ${cond(both, nB)}   ` +
      `RED days ${idA} ${aS.filter((s) => s === "RED").length} · ${idB} ${bS.filter((s) => s === "RED").length}`,
  ];
}

interface PairResult {
  measured: boolean;
  lines: string[];
}

function measurePair(idA: string, idB: string, a: SeriesPoint[], b: SeriesPoint[]): PairResult {
  const mapA = new Map(a.map((p) => [p.date, p]));
  const mapB = new Map(b.map((p) => [p.date, p]));
  const dates = [...mapA.keys()].filter((d) => mapB.has(d)).sort();
  const n = dates.length;
  const head = `  ${idA} vs ${idB}`;
  if (n < MIN_OBS) {
    return {
      measured: false,
      lines: [
        `${head}   UNMEASURED — only ${n} overlapping observations (< MIN_OBS=${MIN_OBS}); ` +
          `${idA} has ${a.length} stored rows, ${idB} has ${b.length}. No verdict may cite this pair.`,
      ],
    };
  }
  const vA = dates.map((d) => mapA.get(d)!.value);
  const vB = dates.map((d) => mapB.get(d)!.value);
  // G1 ALIASING — byte-identical stored values mean one series read twice; every r below would be 1.
  if (vA.every((x, i) => x === vB[i])) {
    throw new Error(
      `[probe-e6b-overlap] ${idA} vs ${idB}: the two stored value vectors are byte-identical over all ` +
        `${n} shared days ${dates[0]} → ${dates.at(-1)}. That is one series read under two ids (id typo, ` +
        `or a duplicated write path) — every correlation below would be a tautology. Fix the ids before ` +
        `reading any number.`,
    );
  }
  const dA = dates.map((d) => mapA.get(d)!.delta20);
  const dB = dates.map((d) => mapB.get(d)!.delta20);
  const sA = dates.map((d) => mapA.get(d)!.state);
  const sB = dates.map((d) => mapB.get(d)!.state);
  const zA = sA.map((s) => SEV[s]);
  const zB = sB.map((s) => SEV[s]);
  // The DECISION variable, where the cron persisted one (the 6 derived ids — F4/F5/F6/F8/G1/NVDA
  // and their siblings — score off `decision`, NOT off `value`/`delta20`, so for those a `value`
  // correlation is a correlation of the wrong quantity). Joined on the sub-window where BOTH ids
  // have a non-null decision; printed with its own n so it can never borrow the pair's n.
  const decDates = dates.filter((d) => mapA.get(d)!.decision != null && mapB.get(d)!.decision != null);
  const decLine =
    decDates.length < MIN_OBS
      ? `    r(decision)   n/a — only ${decDates.length} days where BOTH ids stored a non-null decision variable` +
        ` (a derived id stores one; a plain FRED/level id stores null)`
      : `    r(decision)   ${rOrNa(
          decDates.map((d) => mapA.get(d)!.decision!),
          decDates.map((d) => mapB.get(d)!.decision!),
          `${idA}.decision`,
          `${idB}.decision`,
        )}   over ${decDates.length} days ${decDates[0]} → ${decDates.at(-1)}   ← the SCORED variable`;
  const rDeltaNum = sd(dA) === 0 || sd(dB) === 0 ? NaN : pearson(dA, dB);
  const llConstant = sd(dA) === 0 || sd(dB) === 0;
  const ll = llConstant ? null : leadLag(dA, dB, LAG_SPAN);
  const railPinned = ll !== null && Math.abs(ll.k) === LAG_SPAN;
  const belowFloor = ll !== null && !(Math.abs(ll.r) >= LL_R_FLOOR);
  const llLine = llConstant
    ? `    Δ20 lead/lag  n/a (a Δ20 arm is constant)`
    : ll === null
      ? `    Δ20 lead/lag  UNMEASURED — every lag in ±${LAG_SPAN}d was skipped (each shifted window fell ` +
        `under MIN_OBS=${MIN_OBS}, or an arm went constant on it), so no argmax was ever computed`
      : `    Δ20 lead/lag  k=${railPinned || belowFloor ? "n/a" : String(ll.k)}  r=${ll.r.toFixed(4)}` +
        (railPinned ? `   ⚠ argmax PINNED to the ±${LAG_SPAN}d rail — the true max is outside the scan` : "") +
        (belowFloor ? `   ⚠ |r| < ${LL_R_FLOOR} floor — a noise peak, not a lead/lag` : "") +
        `   (positive k ⇒ ${idA} LEADS ${idB})`;
  return {
    measured: true,
    lines: [
      `${head}   n=${n} shared obs   ${dates[0]} → ${dates.at(-1)}`,
      `    r(level)      ${rOrNa(vA, vB, idA, idB)}`,
      `    r(Δ${VELOCITY_WINDOW})        ${rOrNa(dA, dB, `${idA}.delta20`, `${idB}.delta20`)}` +
        (Number.isNaN(rDeltaNum) ? "" : `   ${rDeltaNum >= SAME_FACTOR_R ? "≥" : "<"} ${SAME_FACTOR_R.toFixed(2)} same-factor line`),
      decLine,
      `    r(state sev)  ${rOrNa(zA, zB, `${idA}.state`, `${idB}.state`)}`,
      llLine,
      ...coFiring(sA, sB, idA, idB),
    ],
  };
}

/** `--aliasing-all`: newest-N cap per id. Above the longest stored history (F5 ≈ 3.4k rows). */
const ALIASING_LIMIT = 5000;

/** `--aliasing-all`: relative tolerance for "the ratio is constant" (float noise on a unit change). */
const SCALE_REL_TOL = 1e-6;

/** `--aliasing-all`: |r| at/above which a non-scaled pair is flagged AFFINE (same series, shifted). */
const AFFINE_R = 0.999999;

type AliasKind = "IDENTICAL" | "NEAR-IDENT" | "SCALED" | "AFFINE";

interface AliasHit {
  kind: AliasKind;
  idA: string;
  idB: string;
  n: number;
  first: string;
  last: string;
  detail: string;
}

/** Classify one pair's joined value vectors; `null` = unrelated or under `MIN_OBS`. */
export function classifyPair(idA: string, idB: string, a: SeriesPoint[], b: SeriesPoint[]): AliasHit | null {
  const mapB = new Map(b.map((p) => [p.date, p.value]));
  const dates: string[] = [];
  const vA: number[] = [];
  const vB: number[] = [];
  for (const p of a) {
    const y = mapB.get(p.date);
    if (y === undefined) continue;
    dates.push(p.date);
    vA.push(p.value);
    vB.push(y);
  }
  const n = dates.length;
  if (n < MIN_OBS) return null;
  const base = { idA, idB, n, first: dates[0]!, last: dates[n - 1]! };
  if (vA.every((x, i) => x === vB[i])) return { ...base, kind: "IDENTICAL", detail: "byte-identical on every shared date" };
  // SCALED: zeros must coincide, and every non-zero ratio must agree to SCALE_REL_TOL.
  let ratio: number | null = null;
  let scaled = true;
  for (let i = 0; i < n; i++) {
    const x = vA[i]!;
    const y = vB[i]!;
    if (x === 0 || y === 0) {
      if (x !== y) {
        scaled = false;
        break;
      }
      continue;
    }
    const q = y / x;
    if (ratio === null) ratio = q;
    else if (Math.abs(q - ratio) > SCALE_REL_TOL * Math.abs(ratio)) {
      scaled = false;
      break;
    }
  }
  if (scaled && ratio !== null) {
    // Ratio 1 within tolerance but not byte-equal = the same series stored at two roundings
    // (F4 / DB_SMH / SMH all persist the SMH close). Not a unit change — labelled apart.
    if (Math.abs(ratio - 1) <= SCALE_REL_TOL) {
      return { ...base, kind: "NEAR-IDENT", detail: `equal to ${SCALE_REL_TOL} relative on every shared date — same series at two roundings` };
    }
    return { ...base, kind: "SCALED", detail: `${idB} = ${ratio.toPrecision(8)} × ${idA} on every shared date (unit change?)` };
  }
  if (sd(vA) === 0 || sd(vB) === 0) return null;
  const r = pearson(vA, vB);
  if (r >= AFFINE_R) return { ...base, kind: "AFFINE", detail: `r(level) = ${r.toFixed(7)} ≥ ${AFFINE_R} but not a constant ratio (shifted copy?)` };
  return null;
}

export async function aliasingAll(env: Env): Promise<void> {
  const store = getStore("ro", env);
  // SCOPE: only the ids wired DB-first (RULED) — the guard
  // protects the db-first splice, so an id not on that path is out of scope, not exempted. Derived from
  // `DB_FIRST_IDS`, never hand-listed.
  const ids = [...new Set(DB_FIRST_IDS)].sort();
  console.log(`${"═".repeat(96)}\nDB-FIRST ALIASING GUARD (§0.3) — the ${ids.length} ids wired db-first, read-only`);
  console.log(`\nINVENTORY (${ids.length} db-first ids, newest ${ALIASING_LIMIT} rows each):`);
  const series = await store.getSeriesBulk(ids, { limit: ALIASING_LIMIT });
  for (const id of ids) {
    const s = series.get(id) ?? [];
    console.log(
      s.length === 0
        ? `  ${id.padEnd(20)}      0 rows   ⚠ enumerated but getSeriesBulk returned nothing`
        : `  ${id.padEnd(20)} ${String(s.length).padStart(6)} rows   ${s[0]!.date} → ${s.at(-1)!.date}`,
    );
  }
  const keys = [...series.keys()];
  let pairs = 0;
  const hits: AliasHit[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = series.get(keys[i]!)!;
      const b = series.get(keys[j]!)!;
      // Cheap pre-check: a pair cannot clear MIN_OBS shared dates if either side is under it.
      if (a.length < MIN_OBS || b.length < MIN_OBS) continue;
      const hit = classifyPair(keys[i]!, keys[j]!, a, b);
      if (hit === null) {
        // classifyPair returns null both for "under MIN_OBS" and "unrelated"; recount shared dates
        // only when needed so `pairs` counts CLEARED pairs, as the docblock promises.
        const setB = new Set(b.map((p) => p.date));
        let shared = 0;
        for (const p of a) if (setB.has(p.date) && ++shared >= MIN_OBS) break;
        if (shared >= MIN_OBS) pairs++;
        continue;
      }
      pairs++;
      hits.push(hit);
    }
  }
  if (pairs === 0) {
    throw new Error(
      `[probe-e6b-overlap --aliasing-all] not one of the ${(keys.length * (keys.length - 1)) / 2} id pairs ` +
        `cleared MIN_OBS=${MIN_OBS} shared dates — this run measured nothing. Check the DB target (.env.prod).`,
    );
  }
  const fmt = (h: AliasHit): string => `  ${h.kind.padEnd(10)} ${h.idA} vs ${h.idB}   n=${h.n} ${h.first} → ${h.last}   ${h.detail}`;
  const isDup = (h: AliasHit): boolean => h.kind === "IDENTICAL" || h.kind === "NEAR-IDENT";
  const warn = hits.filter((h) => !isDup(h));
  const dups = hits.filter(isDup);
  console.log(`\n${"─".repeat(96)}`);
  if (warn.length === 0) console.log(`SCALE/AFFINE WARNINGS: none`);
  else {
    console.log(`SCALE/AFFINE WARNINGS (${warn.length}) — a derived transform of another stored series (not a duplicate row), review before wiring:`);
    for (const h of warn) console.log(`WARNING${fmt(h)}`);
  }
  console.log(`\n${"═".repeat(96)}`);
  if (dups.length > 0) {
    console.log(`ALIASING: ${dups.length} duplicate pair(s) (IDENTICAL or NEAR-IDENT) among ${keys.length} ids / ${pairs} pairs cleared MIN_OBS=${MIN_OBS}:`);
    for (const h of dups) console.log(fmt(h));
    throw new Error(
      `[probe-e6b-overlap --aliasing-all] ${dups.length} stored id pair(s) hold the same series ` +
        `(${dups.map((h) => `${h.idA}=${h.idB}`).join(", ")}) — one series stored under two ids. ` +
        `§0.3 forbids wiring the db-first cron on top of this; retire the duplicate write paths first.`,
    );
  }
  console.log(`ALIASING: none among ${keys.length} ids / ${pairs} pairs cleared MIN_OBS=${MIN_OBS}` +
    (warn.length > 0 ? ` (${warn.length} scale/affine warning(s) above)` : ""));
}

async function main(): Promise<void> {
  const env = readEnv();
  if (hasFlag("aliasing-all")) {
    await aliasingAll(env);
    return;
  }
  const store = getStore("ro", env);
  const ids = [...new Set(GROUPS.flatMap((g) => g.ids))];
  const series = new Map<string, SeriesPoint[]>();
  for (const id of ids) series.set(id, await store.getSeries(id, SERIES_LIMIT));

  console.log(`${"═".repeat(96)}\nE6(b) DUPLICATE-CANDIDATE OVERLAP — stored PROD series (readings_latest), read-only`);
  console.log(`\nINVENTORY (${ids.length} ids):`);
  const empty: string[] = [];
  for (const id of ids) {
    const s = series.get(id)!;
    if (s.length === 0) {
      empty.push(id);
      console.log(`  ${id.padEnd(16)}      0 rows   ⚠ NOT STORED IN PROD — every pair it belongs to is UNMEASURED`);
      continue;
    }
    const lit = s.filter((p) => isLit(p.state)).length;
    console.log(
      `  ${id.padEnd(16)} ${String(s.length).padStart(6)} rows   ${s[0]!.date} → ${s.at(-1)!.date}   ` +
        `latest value ${s.at(-1)!.value.toFixed(4)}  state ${s.at(-1)!.state}   AMBER+ on ${lit} (${pct(lit / s.length)})`,
    );
  }
  if (empty.length > 0) console.log(`\n  G3 EMPTY-READ: ${empty.join(", ")} returned zero prod rows.`);

  let pairs = 0;
  let measured = 0;
  for (const g of GROUPS) {
    console.log(`\n${"─".repeat(96)}\n${g.key.toUpperCase()} — ${g.title}`);
    for (let i = 0; i < g.ids.length; i++) {
      for (let j = i + 1; j < g.ids.length; j++) {
        pairs++;
        const res = measurePair(g.ids[i]!, g.ids[j]!, series.get(g.ids[i]!)!, series.get(g.ids[j]!)!);
        if (res.measured) measured++;
        console.log(res.lines.join("\n"));
      }
    }
  }

  // G2 NON-VACUITY — a run where nothing cleared MIN_OBS measured nothing; say so with an exit code
  // rather than emitting a page of UNMEASURED rows that reads like a result.
  if (measured === 0) {
    throw new Error(
      `[probe-e6b-overlap] not one of the ${pairs} pairs cleared MIN_OBS=${MIN_OBS} overlapping ` +
        `observations, so this run measured nothing at all. Check the DB target (.env.prod) and the ` +
        `stored-row inventory above before quoting any line of this output.`,
    );
  }
  console.log(`\n${"═".repeat(96)}\nMEASURED ${measured}/${pairs} pairs (the rest are UNMEASURED and carry no verdict).`);
}

// Importing this module (the co-located test drives `aliasingAll` with a mocked store) runs no read.
const isMain = process.argv[1]?.endsWith("probe-e6b-overlap.ts") ?? false;
if (isMain) await main();
