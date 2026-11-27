/**
 * W3-a Stage 1.1 — the read-only probe that
 * produces the per-close evidence the top-2-mean-vs-max `positionP` decision needs.
 *
 *   npm run probe:top2 -- --env=local --closes=1500 --out=/tmp/w3a-armA.json
 *
 * The thing under measurement is the SHIPPED `computeT1Dial`, called directly — this probe
 * builds no parameterized re-implementation of the dial and gates on no fidelity harness.
 * Stage 1.2 runs it twice (arm A = HEAD, arm B = the patched `positionRaw`) and diffs the JSON.
 *
 * ⚠ **STRICTLY READ-ONLY:** `getSeries` selects only — never insert/update/delete/upsert.
 * (The dev-DB history is irreplaceable; see `docs/reference.md` §[runbook] Database (local Supabase).)
 *
 * ⚠ **The per-close loop is `src/replay.ts`'s `computeReplay` loop, hand-rolled — deliberately.**
 * `computeReplay` is preferred and was checked first, but its `ReplayPoint` exposes only
 * `{date, targetRung, band: AlertLevel, regime, r4Phase, cash, reentryRung}`. This probe must
 * emit `positionP` / `leadingP` / `coincidentP` / `techConfirmerP` / the continuous `rung` /
 * the numeric `band.{lo,hi}` — the exact terms the top-2 patch moves — and none of those survive
 * `ReplayPoint`. So the loop is mirrored (forward-fill → `computeFamilyPanel` →
 * `techConfirmerBreadth(techConfirmerFromPanel(...))` → `computeT1Dial`) while the DIAL ITSELF is
 * imported, never reimplemented. R4 is intentionally absent: the cash overlay sits downstream of
 * `positionP` and is not under test here.
 *
 * Store resolution mirrors scripts/backfill (`resolve-store.ts`) and scripts/backtest/stage1c:
 * SUPABASE_URL+KEY in env → that store; else `--env=prod` pulls prod creds via the Management API.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { regimeToBand } from "../src/alert-band.js";
import { computeFamilyPanel, GLOBAL_FAMILIES, type FamilyRegime } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import type { AlertLevel } from "../src/ladder.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { countBy, mean } from "./lib/stats.js";
import {
  loadSeries,
  coverageOf,
  printCoverage,
  calendarFrom,
  selectReplayDates,
  walkReplay,
} from "./lib/replay-walk.js";

// ---------- args ----------

/** ~6 trading years. The probe's own coverage ABORT validates it: on a shallower store it exits
 *  non-zero and prints the achievable max, and the executor re-runs with that number. */
const DEFAULT_CLOSES = 1500;
const REPLAY_N = Number(argOf("closes") ?? DEFAULT_CLOSES);
const envArg = envArgOf("local");
const fromArg = argOf("from");
const toArg = argOf("to");
const outArg = argOf("out");

/** Warm-up/pre-history slack on each member read, so a monthly member is filled at the window start. */
const FETCH_SLACK = 400;

if (!Number.isFinite(REPLAY_N) || REPLAY_N < 1) {
  console.log(`ABORT: --closes must be a positive integer (got ${argOf("closes")}).`);
  process.exit(1);
}

const store = await resolveStore(envArg, "ro", liveResolveDeps);

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
const memberIds = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];
// Parallel fetch + the fail-loud ABORT on a swallowed fetch failure — `lib/replay-walk.ts`
// §loadSeries carries the reasoning verbatim (a silently-[] member moves positionP in one arm only).
const seriesById = await loadSeries(store, memberIds, REPLAY_N + FETCH_SLACK);

// ---------- coverage (à la ReplayCoverage) ----------
const coverage = coverageOf(seriesById, memberIds);

console.log(`W3-a positionP probe — env=${envArg}  closes=${REPLAY_N}`);
console.log(`members: ${memberIds.length} (GLOBAL_FAMILIES)`);
printCoverage(coverage);

// ---------- calendar + the ABORT guard (no silent truncation) ----------
// Calendar = F4 daily closes (`calendarFrom`'s default axis), exactly stage1c's axis. The
// axis-vs-computeReplay caveat lives at `lib/replay-walk.ts` §calendarFrom: absolute rates here are
// per-F4-trading-day, not per computeReplay-point (harmless to the A/B diff — both arms share it).
const calendar = calendarFrom(seriesById);
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N, fromArg, toArg });

// ---------- replay ----------
interface Row {
  date: string;
  rung: number;
  targetRung: number;
  regime: FamilyRegime;
  bandLo: number;
  bandHi: number;
  positionP: number;
  leadingP: number;
  coincidentP: number;
  techConfirmerP: number;
  notifyBand: AlertLevel;
}
// The walk (cursor + ascending iteration + the INCLUSIVE forward-fill horizon) is
// `lib/replay-walk.ts`'s `walkReplay`; the fold state `S` is this probe's own row accumulator, so
// nothing measurement-bearing crosses the seam — the dial call below stays here, unchanged.
const rows = await walkReplay<Row[]>({
  dates: replayDates,
  seriesById,
  ids: memberIds,
  initial: [],
  onClose: ({ date, readings, state }) => {
    // B-11: reduce against the DIAL table, not GLOBAL_FAMILIES. This probe walks PERSISTED rows,
    // and the display-only SLOW legs ARE persisted — folding them here would replay a
    // rung/band the live cron dial can never produce. (Display folds keep GLOBAL_FAMILIES.)
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
    const dial = computeT1Dial(panel.families, techP);

    state.push({
      date,
      rung: dial.rung,
      targetRung: dial.targetRung,
      regime: dial.regime,
      bandLo: dial.band.lo,
      bandHi: dial.band.hi,
      positionP: dial.positionP,
      leadingP: dial.leadingP,
      coincidentP: dial.coincidentP,
      techConfirmerP: dial.techConfirmerP,
      notifyBand: regimeToBand(dial.notifyRegime), // notify-axis
    });
    return state;
  },
});

// ---------- report ----------
console.log(
  `\nreplayed ${rows.length} closes  ${rows[0]!.date} → ${rows.at(-1)!.date}` +
    ` (≈ ${(rows.length / 252).toFixed(2)} trading-yrs)`,
);
console.log(`    notify band: ${countBy(rows.map((r) => r.notifyBand)).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(`    regime:      ${countBy(rows.map((r) => r.regime)).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(`    targetRung:  ${countBy(rows.map((r) => r.targetRung)).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(
  `    mean positionP ${mean(rows.map((r) => r.positionP)).toFixed(4)}` +
    `   leadingP ${mean(rows.map((r) => r.leadingP)).toFixed(4)}` +
    `   coincidentP ${mean(rows.map((r) => r.coincidentP)).toFixed(4)}` +
    `   techConfirmerP ${mean(rows.map((r) => r.techConfirmerP)).toFixed(4)}`,
);

if (outArg) {
  writeFileSync(
    outArg,
    JSON.stringify(
      { env: envArg, closes: REPLAY_N, from: fromArg ?? null, to: toArg ?? null, coverage, rows },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${rows.length} rows → ${outArg}`);
}
