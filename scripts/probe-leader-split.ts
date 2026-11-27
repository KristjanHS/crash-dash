/**
 * W3-b Stage 3.3 — the
 * read-only probe that grounds the band-width derivation in real replayed history BEFORE the
 * emission change (Stage 3.5) ships.
 *
 *   npm run probe:leader-split                    # local stack, last 10y
 *   npm run probe:leader-split -- --env=prod --years=5
 *
 * ⚠ **STRICTLY READ-ONLY:** `getSeriesBulk` selects only — never insert/update/delete/upsert.
 * The handle below is `resolveStore(env, "ro")` — a `ReadStore` with no write method. The dev-DB history is irreplaceable
 * (see `docs/reference.md` §[runbook] Database (local Supabase)) — do not add a write here.
 *
 * ⚠ **`firingSplit`, `computeT1Dial` and `computeField` are all IMPORTED, never reimplemented**
 * (§2.2's explicit instruction, the discipline `scripts/probe-arm-rank.ts` set — that probe retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it)). The only thing
 * this script re-derives is the width arithmetic `round(POSITION_SPAN × split)`, which does not
 * exist in the product yet — that IS the thing Stage 3.5 will add.
 *
 * ⚠ **ONE deliberate exception: the CONTROL arm IS reimplemented here** (`loOldRaw`/`bandOld`), from
 * FROZEN literals. Stage 3.5 replaced production's `band.lo` emission, so an imported control is the
 * treatment arm wearing a control's name — the comparison collapses to A/A and its perfect agreement
 * reads as "no regression". So the control is reimplemented here, plus a throw-guard when the arms
 * agree day-for-day; both are below.
 *
 * ⚠ **Data source is `computeReplay` (`src/replay.ts:93`), named in §2.1.** Its forward-fill loop
 * is re-run here rather than called, because `ReplayPoint` emits only
 * `{date, targetRung, band: AlertLevel, regime, r4Phase, cash, reentryRung}` and DISCARDS the
 * `FamilyPanel[]` (`src/replay.ts:139`) that the leader split is computed from. The loop below is
 * that loop — union-date axis, per-member cursor walk, `FFILL_MAX_CALENDAR_DAYS` horizon,
 * `computeFamilyPanel` → `techConfirmerBreadth(techConfirmerFromPanel(...))` → `computeT1Dial` —
 * with the leader panels KEPT. R4 is intentionally absent: the cash overlay sits downstream of the
 * band and is not under test here.
 *
 * Store resolution mirrors scripts/backfill (`resolve-store.ts`), as `probe-top2-position.ts` does.
 *
 * This script REPORTS §2.3's four blocks. It does not recommend and does not tune a constant —
 * there is no constant to pick (§2.3). The §2.4 decision rules are a HUMAN gate.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import {
  computeFamilyPanel,
  GLOBAL_FAMILIES,
  LADDER,
  type FamilyPanel,
  type FamilyKey,
} from "../src/families.js";
import {
  ARMED_UNFIRED_CAP,
  computeT1Dial,
  firingSplit,
  techConfirmerBreadth,
  techConfirmerFromPanel,
} from "../src/t1dial.js";
import { computeField } from "../src/danger-engine.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { FFILL_MAX_CALENDAR_DAYS, REPLAY_MAX_YEARS } from "../src/replay.js";
import type { SeriesPoint } from "../src/store.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { loadSeriesWith, unionCalendar, walkReplay } from "./lib/replay-walk.js";
import { pctOf, quantileLinear } from "./lib/stats.js";
import { isoDay } from "../src/dates.js";

// ---------- args ----------

const envArg = envArgOf("local");
const yearsArg = Number(argOf("years") ?? REPLAY_MAX_YEARS);
/** Per-id row cap on the single `getSeriesBulk` round-trip — 10y of daily closes plus slack. */
const FETCH_LIMIT = Number(argOf("limit") ?? 4000);

if (!Number.isFinite(yearsArg) || yearsArg <= 0) {
  console.log(`ABORT: --years must be a positive number (got ${argOf("years")}).`);
  process.exit(1);
}

// ---------- constants mirrored from t1dial.ts (module-private there) ----------
// `POSITION_SPAN` and `LADDER_MIN` are not exported (`src/t1dial.ts:75`, `:77`). They are mirrored
// here ONLY to evaluate §1.2's proposed width arithmetic, which no shipped function computes yet.
// The mirror is guarded below against the one exported combination that constrains it, so a source
// drift trips the probe instead of silently skewing every widthNew.
const POSITION_SPAN = 2;
const UNARMED_CAP = 3;
const LADDER_MIN = 1;
if (ARMED_UNFIRED_CAP !== UNARMED_CAP + POSITION_SPAN) {
  console.log(
    `ABORT: mirrored dial constants drifted — ARMED_UNFIRED_CAP=${ARMED_UNFIRED_CAP} but the ` +
      `mirror says UNARMED_CAP+POSITION_SPAN=${UNARMED_CAP + POSITION_SPAN}. Re-read src/t1dial.ts ` +
      `before trusting any width below.`,
  );
  process.exit(1);
}

/**
 * FROZEN 2026-07-18 baseline for the CONTROL arm — deliberately NOT imports.
 *
 * These reproduce the RETIRED graded ARM-breadth floor as it stood at the retiring commit's parent, i.e. the last
 * commit before Stage 3.5 replaced the `band.lo` emission. The control arm is a HISTORICAL
 * CONSTANT: importing `LADDER_MIN`/`LADDER_MAX`/`LG_CAP` from `src/t1dial.ts` would let a later
 * source edit move the baseline underneath the comparison — the same drift channel that collapsed
 * this probe to A/A in the first place. They are literals so the control can only be changed
 * deliberately, by editing this block. Do NOT "de-duplicate" them against `t1dial.ts`.
 */
const LO_MIN = 1;
const LO_MAX = 9;
const LG_CAP = 2;

/** LEADING = the EARLY-WARN channels minus valuation (`LEADING` in `src/t1dial.ts`) — mirrored, same reason. */
const LEADING_KEYS: readonly FamilyKey[] = ["credit", "rates"];
/**
 * §2.1's coverage precondition — RE-SPEC'd per DEC-W3B-1 = (A), 2026-07-18.
 *
 * The original flat 250-row floor was **unsatisfiable by construction**: it aborted on `credit/EBP`
 * (119 rows over 10y = FULL coverage for a monthly series) and on `rates/EURC` (a genuinely new feed
 * with no history that any reseed could produce), alongside the one real 1-row partial-persist defect
 * it was written to catch. A row count cannot express the property that actually matters —
 * *does this member forward-fill a FAKE flat family state?* — because that is a question about
 * **cadence relative to `FFILL_MAX_CALENDAR_DAYS`**, not about volume.
 *
 * The gate is therefore span + cadence, and it separates two classes a row floor conflates:
 *   ABORT  — cadence is undefined or broken: fewer than 2 observations (the partial-persist defect;
 *            reseedable), an internal gap > `FFILL_MAX_CALENDAR_DAYS` (the member silently drops out
 *            mid-window, distorting the split's `nLive` denominator), or a trailing gap that stale
 *            by the same horizon (a dead feed).
 *   WARN   — a **young** feed whose first observation postdates the replay window start. This is NOT
 *            a defect and no reseed can clear it: before its first row the replay simply omits the
 *            member (`i < 0 ⇒ continue`), which is honest degrade, not faked unanimity.
 *
 * Every threshold is `FFILL_MAX_CALENDAR_DAYS` — the replay's own declared lag tolerance
 * (`src/replay.ts`). No new constant is introduced, and nothing here enters shipped code.
 *
 * `--diagnostic` downgrades ABORT to WARN for a deliberately-labelled shape-check run; such a run does
 * NOT clear §2.1 and its numbers must not be fed to §2.4's decision rules — the report says so at the
 * top and at the bottom.
 */
const DIAGNOSTIC = process.argv.includes("--diagnostic");

const MS_PER_CALENDAR_DAY = 86_400_000;

// ---------- data pull (READ-ONLY: getSeriesBulk selects only) ----------
const store = await resolveStore(envArg, "ro", liveResolveDeps);

const memberIds = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];
const leaderIds = [
  ...new Set(GLOBAL_FAMILIES.filter((f) => LEADING_KEYS.includes(f.key)).flatMap((f) => f.ids)),
];

const today = new Date();
const fromIso = isoDay(new Date(today.getTime() - yearsArg * 365.25 * MS_PER_CALENDAR_DAY));

const bulk = await store.getSeriesBulk(memberIds, { limit: FETCH_LIMIT, range: { from: fromIso } });
// `loadSeriesWith` with the bulk round-trip resolved per id: one SELECT, still, and the fail-loud
// ABORT is unreachable here by construction (a map lookup cannot reject) — it is adopted for the
// shared shape, not for a new guard.
const seriesById = await loadSeriesWith(
  (id): Promise<SeriesPoint[]> => Promise.resolve(bulk.get(id) ?? []),
  memberIds,
);

console.log(`W3-b leader-split probe — env=${envArg}  years=${yearsArg}  from=${fromIso}`);
console.log(`members: ${memberIds.length} (GLOBAL_FAMILIES); leaders (credit+rates): ${leaderIds.length}`);

// ---------- BLOCK 0 — §2.1 coverage precondition (checked and printed FIRST) ----------
const todayIso = isoDay(today);
const daysBetween = (aIso: string, bIso: string): number =>
  Math.floor((Date.parse(bIso) - Date.parse(aIso)) / MS_PER_CALENDAR_DAY);

console.log(
  `\n══ P0 — LEADER COVERAGE (precondition; span + cadence vs ` +
    `FFILL_MAX_CALENDAR_DAYS=${FFILL_MAX_CALENDAR_DAYS}) ══`,
);
const broken: string[] = [];
const young: string[] = [];
for (const f of GLOBAL_FAMILIES) {
  if (!LEADING_KEYS.includes(f.key)) continue;
  for (const id of f.ids) {
    const pts = seriesById.get(id) ?? [];
    const first = pts[0]?.date;
    const last = pts.at(-1)?.date;

    let maxGap = 0;
    for (let i = 1; i < pts.length; i++) {
      maxGap = Math.max(maxGap, daysBetween(pts[i - 1]!.date, pts[i]!.date));
    }
    const trailing = last ? daysBetween(last, todayIso) : Infinity;

    let verdict = "ok";
    if (pts.length < 2) {
      verdict = "BROKEN";
      broken.push(`${f.key}/${id} — ${pts.length} observation(s): cadence undefined (partial persist)`);
    } else if (maxGap > FFILL_MAX_CALENDAR_DAYS) {
      verdict = "BROKEN";
      broken.push(
        `${f.key}/${id} — internal gap ${maxGap}d > ${FFILL_MAX_CALENDAR_DAYS}d: drops out mid-window`,
      );
    } else if (trailing > FFILL_MAX_CALENDAR_DAYS) {
      verdict = "BROKEN";
      broken.push(`${f.key}/${id} — last observation ${trailing}d lag: dead feed`);
    } else if (first && daysBetween(fromIso, first) > FFILL_MAX_CALENDAR_DAYS) {
      verdict = "young";
      young.push(`${f.key}/${id} — participates from ${first} only (${daysBetween(fromIso, first)}d into the window)`);
    }

    const flag = verdict === "BROKEN" ? "  ⚠ BROKEN" : verdict === "young" ? "  · young" : "";
    console.log(
      `    ${f.key.padEnd(7)} ${id.padEnd(6)} ${String(pts.length).padStart(6)} rows   ` +
        `${first ?? "—"} → ${last ?? "—"}   maxGap ${String(maxGap).padStart(4)}d  ` +
        `trailing ${String(Number.isFinite(trailing) ? trailing : "—").padStart(4)}d${flag}`,
    );
  }
}
if (young.length > 0) {
  console.log(
    `\n    · YOUNG FEEDS (reported, NOT a failure — the replay omits them before their first row,\n` +
      `      which is honest degrade, not faked unanimity). The store cannot tell a genuinely NEW\n` +
      `      feed from an UNSEEDED one; \`npm run backfill -- indicators\` and re-run to separate them\n` +
      `      (that is exactly how F13's missing backfill entry was found on 2026-07-18):\n` +
      `      ${young.join("\n      ")}`,
  );
}
const specCleared = broken.length === 0;
if (broken.length > 0) {
  const head = DIAGNOSTIC ? "⚠⚠ DIAGNOSTIC RUN — coverage is BROKEN" : "ABORT: leader coverage is BROKEN";
  console.log(
    `\n${head} — reseed before measuring.\n` +
      `    ${broken.join("\n    ")}\n` +
      `    (seed with \`npm run backfill -- all\`; a member whose cadence is undefined or broken\n` +
      `     forward-fills a flat family state, or silently leaves the panel, and would skew the split.)`,
  );
  if (!DIAGNOSTIC) process.exit(1);
  console.log(
    `\n    §2.1's precondition is NOT cleared. The blocks below are a shape-check only;\n` +
      `    they MUST NOT be fed to §2.4's decision rules.`,
  );
} else {
  console.log(
    `    → all ${leaderIds.length} leader members clear the span + cadence precondition` +
      `${young.length > 0 ? ` (${young.length} young, reported above)` : ""}.`,
  );
}

// ---------- replay (computeReplay's loop, leader panels KEPT) ----------
interface Row {
  date: string;
  nLive: number;
  L: number;
  split: number;
  targetRung: number;
  widthOld: number;
  widthNew: number;
  loOld: number;
  loNew: number;
  heldOld: string;
  heldNew: string;
  /** true when the band admits no leg at all (the `src/run-core.ts` fallback path). */
  emptyFieldNew: boolean;
  emptyFieldOld: boolean;
}

const unionDates = unionCalendar(seriesById, memberIds);

const rungOf = (sleeve: string): number => (LADDER as readonly string[]).indexOf(sleeve) + 1;

const rows: Row[] = [];
/**
 * The walk's fold state — the two arms' priors, side by side in ONE object, which is exactly the
 * shape `walkReplay`'s seam-4 contract puts in the caller (`lib/replay-walk.ts`).
 *
 * Threaded per arm, exactly as `run-core.ts` does: prevTarget = the rung of the previously-HELD
 * sleeve, which drives `computeField`'s directional deadband. Each arm carries its own prior, so
 * the two held paths are compared as they would actually run, not against a shared oracle.
 */
interface PrevTargets {
  old: number | null;
  new: number | null;
}

await walkReplay<PrevTargets>({
  dates: unionDates,
  seriesById,
  ids: memberIds,
  initial: { old: null, new: null },
  onClose: ({ date: dayIso, readings, state: prev }) => {
    // B-11: reduce against the DIAL table, not GLOBAL_FAMILIES. This probe walks PERSISTED rows,
    // and the display-only SLOW legs ARE persisted — folding them here would replay a
    // rung/band the live cron dial can never produce. (Display folds keep GLOBAL_FAMILIES.)
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
    const dial = computeT1Dial(panel.families, techP);

    // The leader panels computeReplay throws away — the whole reason this loop is re-run.
    const leading: FamilyPanel[] = panel.families.filter(
      (f) => LEADING_KEYS.includes(f.key) && f.live,
    );
    // S4: production's width is the MAX of the
    // band-role split and the unrestricted one, so this treatment arm must take the same max — the
    // Gini is non-monotone (0 at l=2), so the band arm can EXCEED the unrestricted one exactly on
    // the credit per-leg-firing days this split exists for.
    const split = Math.max(
      firingSplit(leading),
      firingSplit(leading, (f) => f.band?.firing ?? f.firing),
    );

    const widthNew = Math.round(POSITION_SPAN * split);
    const bandNew = { lo: Math.max(LADDER_MIN, dial.targetRung - widthNew), hi: dial.targetRung };
    // CONTROL ARM — the RETIRED graded ARM-breadth floor, REIMPLEMENTED here from FROZEN literals.
    // It must NOT read `dial.band` (`computeT1Dial`'s emission): Stage 3.5 replaced that very
    // expression with the new width, so reading it would make this an A/A comparison whose perfect
    // agreement reads as "no regression" (the exact defect the since-retired `probe-arm-rank.ts` shipped with). Verified against `src/t1dial.ts` at that parent
    // (`loRaw` + the `band` literal) — the pre-Stage-3.5 source, byte-for-byte.
    const loOldRaw =
      LO_MIN + (LO_MAX - LO_MIN - POSITION_SPAN) * (Math.min(dial.leadingFiring, LG_CAP) / LG_CAP);
    const bandOld = { lo: Math.min(Math.round(loOldRaw), dial.targetRung), hi: dial.targetRung };
    const widthOld = bandOld.hi - bandOld.lo;

    const fieldOld = computeField({ globalFamilies: panel.families }, bandOld, undefined, prev.old);
    const fieldNew = computeField({ globalFamilies: panel.families }, bandNew, undefined, prev.new);
    const dialSleeve = LADDER[dial.targetRung - 1] ?? LADDER[LADDER.length - 1]!;
    const heldOld = fieldOld.held?.sleeve ?? dialSleeve;
    const heldNew = fieldNew.held?.sleeve ?? dialSleeve;

    rows.push({
      date: dayIso,
      nLive: leading.length,
      L: leading.filter((f) => f.firing).length,
      split,
      targetRung: dial.targetRung,
      widthOld,
      widthNew,
      loOld: bandOld.lo,
      loNew: bandNew.lo,
      heldOld,
      heldNew,
      emptyFieldNew: fieldNew.held === null,
      emptyFieldOld: fieldOld.held === null,
    });

    return { old: rungOf(heldOld) || null, new: rungOf(heldNew) || null };
  },
});

if (rows.length === 0) {
  console.log("\nABORT: the replay produced 0 days — no member observations in range.");
  process.exit(1);
}

// ---------- A/A guard ----------
// An A/B probe whose control arm has silently become the treatment arm reports perfect agreement,
// which reads as "no regression". This throws on exactly that shape. It CAN fail: revert the
// control to `dial.band` (the pre-fix code) and every row agrees day-for-day, tripping it.
const anyWidthDiffers = rows.some((r) => r.widthOld !== r.widthNew);
const anyHeldDiffers = rows.some((r) => r.heldOld !== r.heldNew);
if (!anyWidthDiffers && !anyHeldDiffers) {
  throw new Error(
    `A/A COLLAPSE: the OLD and NEW arms agree day-for-day across all ${rows.length} replayed days ` +
      `(width AND held identical on every row). The control arm is no longer a control — most ` +
      `likely it is reading production's emitted band instead of reimplementing the retired graded ` +
      `ARM floor from this file's FROZEN literals. Every number below would be meaningless.`,
  );
}

// ---------- helpers ----------
const yearOf = (d: string): string => d.slice(0, 4);

/** Non-degraded = both LEADING channels live. A single live leader has nothing to corroborate. */
const scored = rows.filter((r) => r.nLive >= 2);
const degraded = rows.length - scored.length;

console.log(
  `\nreplayed ${rows.length} union-date closes  ${rows[0]!.date} → ${rows.at(-1)!.date}` +
    ` (≈ ${(rows.length / 252).toFixed(2)} trading-yrs);  ${degraded} degraded (nLive < 2), ` +
    `${scored.length} scored`,
);

// ---------- P1 — split share ----------
console.log(`\n══ P1 — SPLIT SHARE (§2.4 rule: >50% of non-degraded days split ⇒ STOP + escalate) ══`);
const splitDays = scored.filter((r) => r.split > 0);
console.log(
  `    split > 0 on ${splitDays.length} / ${scored.length} non-degraded days = ${pctOf(splitDays.length, scored.length)}`,
);
console.log(`    L distribution (non-degraded): ` +
  [0, 1, 2]
    .map((l) => `L=${l}: ${scored.filter((r) => r.L === l).length}`)
    .join("   "));
console.log(`    by year:`);
const years = [...new Set(scored.map((r) => yearOf(r.date)))].sort();
for (const y of years) {
  const ys = scored.filter((r) => yearOf(r.date) === y);
  const ysplit = ys.filter((r) => r.split > 0).length;
  console.log(`        ${y}   ${String(ysplit).padStart(4)} / ${String(ys.length).padStart(4)} = ${pctOf(ysplit, ys.length).padStart(6)}`);
}

// ---------- P2 — split run-lengths ----------
console.log(
  `\n══ P2 — SPLIT RUN-LENGTHS (§2.4 rule: median split-run < 5 trading days ⇒ escalate) ══`,
);
// Runs are measured on the CONTIGUOUS non-degraded segments only: a degraded day is not evidence of
// either agreement or disagreement, so it terminates the run rather than joining two across a hole.
const runsSplit: number[] = [];
const runsUnanimous: number[] = [];
let runVal: boolean | null = null;
let runLen = 0;
const flush = (): void => {
  if (runVal === null || runLen === 0) return;
  (runVal ? runsSplit : runsUnanimous).push(runLen);
  runLen = 0;
};
for (const r of rows) {
  if (r.nLive < 2) {
    flush();
    runVal = null;
    continue;
  }
  const v = r.split > 0;
  if (v !== runVal) {
    flush();
    runVal = v;
  }
  runLen++;
}
flush();
for (const [label, rs] of [
  ["split > 0", runsSplit],
  ["split = 0", runsUnanimous],
] as const) {
  const s = [...rs].sort((a, b) => a - b);
  console.log(
    `    ${label}:  ${s.length} runs   median ${quantileLinear(s, 0.5).toFixed(1)}d   ` +
      `p10 ${quantileLinear(s, 0.1).toFixed(1)}d   p90 ${quantileLinear(s, 0.9).toFixed(1)}d   ` +
      `max ${s.length ? s[s.length - 1] : "—"}d`,
  );
}

// ---------- P3 — collapse cost ----------
console.log(
  `\n══ P3 — COLLAPSE COST on unanimous days (widthNew = 0) ` +
    `(§2.4 rule: empty-field rate > 5% ⇒ escalate) ══`,
);
const unanimous = scored.filter((r) => r.widthNew === 0);
const empty = unanimous.filter((r) => r.emptyFieldNew);
console.log(`    unanimous non-degraded days: ${unanimous.length} / ${scored.length}`);
console.log(
  `    (a) empty in-band field under the 1-rung band: ${empty.length} / ${unanimous.length} = ` +
    `${pctOf(empty.length, unanimous.length)}   (the run-core.ts fallback path)`,
);
// (b) day-over-day targetRung change rate — a zero-width band transmits it 1:1 to the held leg.
let tChanges = 0;
let tPairs = 0;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1]!;
  const b = rows[i]!;
  if (a.nLive < 2 || b.nLive < 2 || b.widthNew !== 0) continue;
  tPairs++;
  if (a.targetRung !== b.targetRung) tChanges++;
}
console.log(
  `    (b) day-over-day targetRung change on unanimous days: ${tChanges} / ${tPairs} = ${pctOf(tChanges, tPairs)}`,
);
// Baseline for (a): today's band is never zero-width-by-agreement, so its empty-field rate is the
// reference the 5% gate is really judged against.
const emptyOld = scored.filter((r) => r.emptyFieldOld);
console.log(
  `    baseline — empty in-band field under TODAY's band: ${emptyOld.length} / ${scored.length} = ` +
    `${pctOf(emptyOld.length, scored.length)} (all non-degraded days)`,
);

// ---------- P4 — held churn ----------
console.log(`\n══ P4 — HELD CHURN (§2.4 rule: held changes more than double vs today ⇒ escalate) ══`);
const differ = scored.filter((r) => r.heldNew !== r.heldOld);
console.log(
  `    days where heldNew ≠ heldOld: ${differ.length} / ${scored.length} = ${pctOf(differ.length, scored.length)}`,
);
const changesPerYear = (pick: (r: Row) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const y of years) m.set(y, 0);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.nLive < 2 || b.nLive < 2) continue;
    if (pick(a) !== pick(b)) m.set(yearOf(b.date), (m.get(yearOf(b.date)) ?? 0) + 1);
  }
  return m;
};
const chOld = changesPerYear((r) => r.heldOld);
const chNew = changesPerYear((r) => r.heldNew);
const totOld = [...chOld.values()].reduce((s, x) => s + x, 0);
const totNew = [...chNew.values()].reduce((s, x) => s + x, 0);
console.log(`    held CHANGES per year:`);
console.log(`        year      old     new`);
for (const y of years) {
  console.log(`        ${y}   ${String(chOld.get(y) ?? 0).padStart(5)}   ${String(chNew.get(y) ?? 0).padStart(5)}`);
}
console.log(
  `        TOTAL  ${String(totOld).padStart(5)}   ${String(totNew).padStart(5)}   ` +
    `ratio new/old = ${totOld ? (totNew / totOld).toFixed(2) : "—"}×`,
);
console.log(
  `    (held here is computeField's pick only — run-core.ts's re-risk confirmation gate sits downstream\n` +
    `     and is identical under both arms, so it is excluded rather than simulated.)`,
);
if (!specCleared) {
  console.log(
    `\n⚠⚠ REMINDER: this was a --diagnostic run over BROKEN leader coverage. §2.1's span + cadence\n` +
      `    precondition is NOT cleared, so §2.4's four decision rules CANNOT be resolved from the\n` +
      `    numbers above.`,
  );
}
console.log(`\n(read-only: this probe issued one getSeriesBulk SELECT and wrote nothing.)`);
