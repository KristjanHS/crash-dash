/**
 * Tech-confirmer {F4,F5} 2-of-2 COLLAPSE guard
 * ([USER DECISION 2026-07-22 — LOCKED: BOTH]).
 *
 *   bash scripts/db.sh with dev -- tsx --env-file-if-exists=.env.local scripts/probe-tech-confirmer.ts                       # LIVE DEV store (db.sh with dev)
 *   npx tsx --env-file-if-exists=.env.local scripts/probe-tech-confirmer.ts --env=prod --closes=2000
 *
 * WHAT IT PROVES: replays real closes through the SHIPPED dial and reports the within-band
 * tech-confirmer DEPTH so a human can eyeball that the NVDA demote (3-slot {F4,F5,NVDA} → 2-slot
 * {F4,F5}) moved only within-band DEPTH, never the notify TIER.
 *
 * TWO ARMS (the control arm is reimplemented in-probe, never imported):
 *   · NEW = the shipped `techConfirmerBreadth(techConfirmerFromPanel(panel))` — {F4,F5}, /2, 2-of-2.
 *   · OLD = the pre-demote 3-slot control, REBUILT here (never imported): the same
 *           `memberScaledBand` over the SAME TECH_LEGS, but for {F4,F5,NVDA} (/3, ≥2-of-3). NVDA's
 *           state is read from its own persisted series (it left the trend panel in the demote, so it
 *           is fetched explicitly — the panel never sees it).
 * The dial is run under BOTH confirmer depths; the report contrasts them. The headline number is
 * `notify tier moved by the collapse: N/total` — 0 ⇒ notify-neutral, the LOCKED expectation.
 *
 * NON-VACUITY: the depth-arms MUST differ on ≥1 close, else the window shows no NVDA effect and the
 * contrast is A/A-collapsed (widen --closes). Reported loudly; the notify-neutral claim is only
 * meaningful once `arms differ on depth` > 0.
 *
 * ⚠ STRICTLY READ-ONLY: `getSeries` selects only. The dev-DB history is irreplaceable
 * (`docs/reference.md` §[runbook] Database (local Supabase)) — never insert/update/delete here.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { regimeToBand } from "../src/alert-band.js";
import { computeFamilyPanel, GLOBAL_FAMILIES } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import { memberScaledBand } from "../src/danger-engine.js";
import type { AlertLevel } from "../src/ladder.js";
import type { State } from "../src/domain-types.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { countBy, mean } from "./lib/stats.js";
import { loadSeries, calendarFrom, selectReplayDates, walkReplay } from "./lib/replay-walk.js";

// ---------- args ----------
const envArg = envArgOf("local");
const DEFAULT_CLOSES = 1500;
const REPLAY_N = Number(argOf("closes") ?? DEFAULT_CLOSES);
const fromArg = argOf("from");
const toArg = argOf("to");

/** The OLD (control) confirmer's leg scaling — a LOCAL copy, never imported from t1dial, so the
 *  shipped change under test cannot move this baseline (that is the whole point of an in-probe
 *  control). Mirrors the pre-demote `TECH_LEGS`. */
const OLD_TECH_LEGS = ["Semis", "S&P IT"] as const;
/** The OLD 3 confirmer slots — {F4,F5} plus the now-demoted NVDA. */
const OLD_SLOT_IDS = ["F4", "F5", "NVDA"] as const;

const FETCH_SLACK = 400;

if (!Number.isFinite(REPLAY_N) || REPLAY_N < 1) {
  console.log(`ABORT: --closes must be a positive integer (got ${argOf("closes")}).`);
  process.exit(1);
}

let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no store reachable for --env=${envArg} — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The dev stack defaults DOWN — re-run under the front door:\n` +
      `      bash scripts/db.sh with dev -- tsx --env-file-if-exists=.env.local scripts/probe-tech-confirmer.ts\n` +
      `    (or hold it open with \`scripts/db.sh up dev\`). Populate .env.local, or pass --env=prod.`,
  );
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
// The DIAL panel members (fold the shipped dial) PLUS NVDA (the OLD control's 3rd slot — it left the
// trend panel in the demote, so it is not in GLOBAL_FAMILIES and must be fetched explicitly).
const memberIds = [...new Set([...GLOBAL_FAMILIES.flatMap((f) => f.ids), "NVDA"])];
// Parallel fetch + the fail-loud ABORT on a swallowed fetch failure — `lib/replay-walk.ts`
// §loadSeries carries the reasoning: a silently-[] member is absent for EVERY date, so a partial
// panel is not comparable across the two depth arms.
const seriesById = await loadSeries(store, memberIds, REPLAY_N + FETCH_SLACK);

// ---------- calendar (F4 trading days) + the no-silent-truncation ABORT ----------
const calendar = calendarFrom(seriesById);
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N, fromArg, toArg });

// ---------- replay ----------
interface Row {
  date: string;
  newDepth: number;
  oldDepth: number;
  newBand: AlertLevel;
  oldBand: AlertLevel;
  newRung: number;
  oldRung: number;
}

console.log(`tech-confirmer collapse probe — env=${envArg}  closes=${REPLAY_N}`);
console.log(`NEW = shipped {F4,F5} /2 2-of-2 · OLD (in-probe control) = {F4,F5,NVDA} /3 ≥2-of-3\n`);

// The walk (cursor + ascending iteration + the INCLUSIVE forward-fill horizon) is
// `lib/replay-walk.ts`'s `walkReplay`; the fold state `S` is this probe's own row accumulator, so
// the two confirmer arms — and their frozen OLD_TECH_LEGS / OLD_SLOT_IDS literals — stay here.
const rows = await walkReplay<Row[]>({
  dates: replayDates,
  seriesById,
  ids: memberIds,
  initial: [],
  onClose: ({ date, readings, state }) => {
    // `readings` is exactly the gap-filtered set the inline loop built; the OLD arm needs it keyed.
    const stateOf = new Map<string, State>(readings.map((r) => [r.id, r.state]));

    // Reduce against the DIAL table (B-11: display-only SLOW legs are persisted but must not fold here).
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);

    // NEW arm — the shipped 2-slot {F4,F5} confirmer, exactly as dial-assembly.ts feeds computeT1Dial.
    const newDepth = techConfirmerBreadth(techConfirmerFromPanel(panel.families));

    // OLD arm — the pre-demote 3-slot {F4,F5,NVDA}, rebuilt in-probe over the same leg scaling. A member
    // absent this close is a null slot (techConfirmerBreadth treats null as not-firing in the /3 mean).
    const oldSlots = OLD_SLOT_IDS.map((m) => {
      const s = stateOf.get(m);
      return s === undefined ? null : memberScaledBand(m, s, OLD_TECH_LEGS);
    });
    const oldDepth = techConfirmerBreadth(oldSlots);

    const newDial = computeT1Dial(panel.families, newDepth);
    const oldDial = computeT1Dial(panel.families, oldDepth);

    state.push({
      date,
      newDepth,
      oldDepth,
      newBand: regimeToBand(newDial.notifyRegime),
      oldBand: regimeToBand(oldDial.notifyRegime),
      newRung: newDial.targetRung,
      oldRung: oldDial.targetRung,
    });
    return state;
  },
});

// ---------- report ----------
const newFiring = rows.filter((r) => r.newDepth > 0);
const oldFiring = rows.filter((r) => r.oldDepth > 0);
const depthDiff = rows.filter((r) => r.newDepth !== r.oldDepth);
const tierMoved = rows.filter((r) => r.newBand !== r.oldBand);

console.log(
  `replayed ${rows.length} closes  ${rows[0]!.date} → ${rows.at(-1)!.date}` +
    ` (≈ ${(rows.length / 252).toFixed(2)} trading-yrs)\n`,
);
console.log(`  NEW notify band: ${countBy(rows.map((r) => r.newBand)).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(`  OLD notify band: ${countBy(rows.map((r) => r.oldBand)).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(
  `  confirmer FIRED (depth>0):  NEW ${newFiring.length}   OLD ${oldFiring.length}   ` +
    `mean depth NEW ${mean(rows.map((r) => r.newDepth)).toFixed(4)}  OLD ${mean(rows.map((r) => r.oldDepth)).toFixed(4)}`,
);
console.log(`  arms differ on WITHIN-BAND depth: ${depthDiff.length}/${rows.length} closes`);
console.log(`  >>> notify tier moved by the collapse: ${tierMoved.length}/${rows.length} closes <<<`);

if (tierMoved.length > 0) {
  console.log(`\n  closes where the notify tier moved (eyeball these):`);
  for (const r of tierMoved.slice(0, 20)) {
    console.log(
      `    ${r.date}  OLD ${r.oldBand}(r${r.oldRung}, d${r.oldDepth.toFixed(3)}) → ` +
        `NEW ${r.newBand}(r${r.newRung}, d${r.newDepth.toFixed(3)})`,
    );
  }
}

// NON-VACUITY: if the arms never differ on depth, NVDA had no effect in this window and the
// notify-neutral claim is A/A-collapsed (proves nothing). Loud, but not a hard error — it is a real,
// data-dependent finding, and widening --closes is the fix.
if (depthDiff.length === 0) {
  console.log(
    `\n  ⚠ VACUOUS: the OLD and NEW confirmer depth AGREE on every close — NVDA never moved the\n` +
      `    confirmer in this window, so "notify tier unmoved" is trivially true. Widen --closes\n` +
      `    (or pick a --from/--to window spanning a semis/NVDA drawdown) to exercise the contrast.`,
  );
} else if (tierMoved.length === 0) {
  console.log(
    `\n  PASS: the collapse changed within-band depth on ${depthDiff.length} close(s) but moved the ` +
      `notify tier on NONE — the {F4,F5} confirmer is a within-band deepener, as designed.`,
  );
}
process.exit(0);
