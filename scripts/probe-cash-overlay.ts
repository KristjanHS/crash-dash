/**
 * W5-a Stage 1.2 — the read-only probe that produces the
 * cash overlay's ACTUAL calibration read.
 *
 *   npm run probe:cash-overlay -- --env=local --closes=1500 --out=/tmp/w5a-overlay.json
 *
 * WHY THIS EXISTS (the stage's own "Known blind spot", made load-bearing by the UD-1 ruling):
 * UD-1 was RULED **(c) dial acceleration**, which is STATEFUL — it fires on a rise in `targetRung`
 * across up to `CASH_ACCEL_WINDOW` closes. `sim:notify` synthesizes each scenario as a SINGLE close
 * with no rung history, so it cannot exercise the trigger AT ALL (it prints `off` in all 15 worlds
 * by construction). The stage's question — "which worlds does the chosen trigger fire in?" — can
 * therefore only be answered over real replayed closes. This probe is that answer.
 *
 * The thing under measurement is the SHIPPED `computeCashOverlay`, folded across the SHIPPED
 * `computeT1Dial`'s `targetRung` sequence. Neither is re-implemented here.
 *
 * ⚠ **STRICTLY READ-ONLY:** `getSeries` selects only — never insert/update/delete/upsert.
 * (The dev-DB history is irreplaceable; see `docs/reference.md` §[runbook] Database (local Supabase).) The handle is
 * `resolveStore(env, "ro")` — a `ReadStore` with no write method, as in the sibling `probe:leader-split`.
 *
 * The per-close walk is `scripts/lib/replay-walk.ts`'s `walkReplay` (itself `src/replay.ts`'s
 * `computeReplay` loop, hand-rolled) because `ReplayPoint` exposes no overlay state to fold. The
 * fold state stays HERE — `walkReplay` owns the cursor and the ascending order, nothing else.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { computeFamilyPanel, GLOBAL_FAMILIES } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import {
  computeCashOverlay,
  CASH_ACCEL_RUNGS,
  CASH_ACCEL_WINDOW,
  type CashOverlayState,
} from "../src/cash-overlay.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { countBy } from "./lib/stats.js";
import {
  calendarFrom,
  coverageOf,
  loadSeries,
  printCoverage,
  selectReplayDates,
  walkReplay,
} from "./lib/replay-walk.js";

// ---------- args ----------

/** ~6 trading years, matching probe:top2's default. */
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

// Degrade with a MESSAGE, not a stack trace, when no DB is reachable — the overwhelmingly common
// failure here is "no local stack running / no creds", which is operator state, not a bug.
let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no store reachable for --env=${envArg} — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The dev stack defaults DOWN — re-run under the front door:\n` +
      `      scripts/db.sh with dev -- npm run probe:cash-overlay\n` +
      `    (or hold it open with \`scripts/db.sh up dev\`). Populate .env.local, or pass --env=prod.`,
  );
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
// `loadSeries` carries the fail-loud ABORT: a member that silently resolves to [] is absent for
// EVERY date, which can drop its family from computeFamilyPanel's worst-of and MOVE targetRung —
// the exact sequence this probe folds over. Fail loud rather than calibrate against a hole.
const memberIds = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeries(store, memberIds, REPLAY_N + FETCH_SLACK);

// ---------- coverage ----------
const coverage = coverageOf(seriesById, memberIds);

console.log(`W5-a cash-overlay probe — env=${envArg}  closes=${REPLAY_N}`);
console.log(
  `trigger: targetRung rise ≥ ${CASH_ACCEL_RUNGS} rungs within ${CASH_ACCEL_WINDOW} closes ` +
    `(UD-1 = (c) dial acceleration)`,
);
console.log(`members: ${memberIds.length} (GLOBAL_FAMILIES)`);
printCoverage(coverage);

// ---------- calendar + the ABORT guards (no silent truncation) ----------
// Calendar = F4 daily closes, the same trading-day axis probe:top2 uses (`calendarFrom`'s default).
const calendar = calendarFrom(seriesById);
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N, fromArg, toArg });

// ---------- replay + the overlay fold ----------
interface Row {
  date: string;
  targetRung: number;
  level: "off" | "partial";
  since: string | null;
  reason: string;
}
const rows: Row[] = [];

// The walk's carried state IS `CashOverlayState` — the same shape Stage 2.1 will persist, so this
// probe measures the trigger as it will actually run, not an offline approximation of it. It lives
// in the caller per `lib/replay-walk.ts` seam 4: the fold is the measurement, the walk is plumbing.
await walkReplay<CashOverlayState>({
  dates: replayDates,
  seriesById,
  ids: memberIds,
  initial: { recentTargetRungs: [], since: null },
  onClose: ({ date: d, readings, state }) => {
    // B-11: reduce against the DIAL table, not GLOBAL_FAMILIES. This probe walks PERSISTED rows,
    // and the display-only SLOW legs ARE persisted — folding them here would replay a
    // rung/band the live cron dial can never produce. (Display folds keep GLOBAL_FAMILIES.)
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
    const dial = computeT1Dial(panel.families, techP);

    // `d` is the close being replayed, so the entry stamp is the close's own date, not wall-clock.
    const overlay = computeCashOverlay(dial, state, () => d);

    rows.push({
      date: d,
      targetRung: dial.targetRung,
      level: overlay.level,
      since: overlay.since,
      reason: overlay.reason,
    });

    return { recentTargetRungs: overlay.recentTargetRungs, since: overlay.since };
  },
});

// ---------- report ----------
const fired = rows.filter((r) => r.level === "partial");
// Episodes = maximal runs of consecutive firing closes. A run is ONE event the user would have
// acted on; the raw close count over-counts a single sustained acceleration.
const episodes: { since: string; from: string; to: string; closes: number }[] = [];
for (const r of rows) {
  if (r.level !== "partial") continue;
  const last = episodes.at(-1);
  if (last && last.since === (r.since ?? r.date)) {
    last.to = r.date;
    last.closes += 1;
  } else {
    episodes.push({ since: r.since ?? r.date, from: r.date, to: r.date, closes: 1 });
  }
}

const pct = rows.length ? (100 * fired.length) / rows.length : 0;
console.log(
  `\nreplayed ${rows.length} closes  ${rows[0]!.date} → ${rows.at(-1)!.date}` +
    ` (≈ ${(rows.length / 252).toFixed(2)} trading-yrs)`,
);
console.log(
  `    FIRED on ${fired.length} of ${rows.length} closes (${pct.toFixed(2)}%) across ${episodes.length} episode(s)`,
);
for (const e of episodes) {
  console.log(`      ${e.from} → ${e.to}  (${e.closes} close${e.closes === 1 ? "" : "s"}, since ${e.since})`);
}
if (fired.length === 0) {
  console.log(
    `      (none — over this window the dial's targetRung never rose ≥${CASH_ACCEL_RUNGS} within ` +
      `${CASH_ACCEL_WINDOW} closes. A zero here is a calibration result, not a failure: it says the ` +
      `chosen trigger is silent on the available history.)`,
  );
}
const rungCounts = countBy(rows.map((r) => r.targetRung))
  .sort((a, b) => a[0] - b[0])
  .map(([k, v]) => `${k}:${v}`)
  .join("  ");
console.log(`    targetRung:  ${rungCounts}`);

if (outArg) {
  writeFileSync(
    outArg,
    JSON.stringify(
      { env: envArg, closes: REPLAY_N, from: fromArg ?? null, to: toArg ?? null, coverage, episodes, rows },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${rows.length} rows → ${outArg}`);
}
