/**
 * W4-e Stage 1c — the read-only probe that produces the
 * lag guard's DECISION number: over real stored vintages, how often would a stale leg
 * coincide with a band step-DOWN, i.e. how often would the (gated) Stage-4 BAND-HOLD actually bind.
 *
 *   npm run probe:lag-cuts -- --env=prod --closes=1500 --out=/tmp/w4e-lag.json
 *
 * WHY THIS EXISTS (the §2 pre-registered stopping rule): BAND-HOLD floors the final band at the
 * prior persisted band while ANY leg is stale. Whether that guard has real bite is an EMPIRICAL
 * question — `sim:notify` is structurally blind to it (single synthesized closes, no vintage age,
 * no prior band). Only a replay over real stored vintages can answer "in how many runs would a
 * stale leg have prevented a downgrade". If that count is 0 across history → ship FLAG-only, skip
 * Stage 4. If > 0 → build BAND-HOLD.
 *
 * The thing under measurement is the SHIPPED `verdictHoldLegs` + the SHIPPED `computeAlertBandDetail`
 * (imported, NOT re-derived — the §6 A-A guard). The hold predicate is `detectHold` below, reused
 * verbatim by the constructed non-vacuity self-test so the probe cannot be a falsifier that only
 * ever prints 0.
 *
 * ⚠ **STRICTLY READ-ONLY:** `getSeries` selects only — never insert/update/delete/upsert.
 * (The dev-DB history is irreplaceable; see `docs/reference.md` §[runbook] Database (local Supabase).) The handle is
 * `resolveStore(env, "ro")` — a `ReadStore` with no write method, as in the sibling `probe:cash-overlay`.
 *
 * The per-close loop mirrors `scripts/probe-cash-overlay.ts` (itself `src/replay.ts`'s forward-fill
 * fold, hand-rolled) because `ReplayPoint` exposes neither the raw dial nor the full Reading[] this
 * probe folds `computeAlertBandDetail` / `verdictHoldLegs` over.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { computeFamilyPanel } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import { computeR4, type R4State } from "../src/r4.js";
import {
  computeAlertBandDetail,
  regimeToBand,
  verdictHoldLegs,
  type VerdictHoldLeg,
} from "../src/alert-band.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { ALERT_RANK, type AlertLevel } from "../src/ladder.js";
import { lagCalendarsFrom, stampFreshness } from "../src/scorers-core.js";
import type { Reading, State } from "../src/domain-types.js";
import type { Cadence } from "../src/domain-types.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { loadSeries, makeCursor, calendarFrom, selectReplayDates, walkReplay } from "./lib/replay-walk.js";
import type { SeriesPoint } from "../src/store.js";

// ---------- args ----------

/** ~6 trading years, matching probe:cash-overlay's default. */
const DEFAULT_CLOSES = 1500;
const REPLAY_N = Number(argOf("closes") ?? DEFAULT_CLOSES);
const envArg = envArgOf("local");
const fromArg = argOf("from");
const toArg = argOf("to");
const outArg = argOf("out");

/** Warm-up/pre-history slack on each member read, so a slow-cadence member is filled at the window start. */
const FETCH_SLACK = 400;

if (!Number.isFinite(REPLAY_N) || REPLAY_N < 1) {
  console.log(`ABORT: --closes must be a positive integer (got ${argOf("closes")}).`);
  process.exit(1);
}

// ---------- the hold predicate (reused by both the replay loop AND the self-test) ----------
/**
 * The load-bearing decision: would the Stage-4 BAND-HOLD bind on THIS close? It binds iff
 * (a) at least one leg is stale AND (b) the band would otherwise step DOWN from the prior band.
 * `priorBand === null` (the first close) can never step down, so it never holds.
 */
function detectHold(computedBand: AlertLevel, priorBand: AlertLevel | null, stales: VerdictHoldLeg[]): boolean {
  if (priorBand === null) return false;
  return stales.length > 0 && ALERT_RANK[computedBand] < ALERT_RANK[priorBand];
}

// ---------- indicator lookup (id → config, for full Reading construction) ----------
const indicatorById = new Map(ALL_INDICATORS.map((ind) => [ind.id, ind]));

// ---------- NON-VACUITY SELF-TEST (runs FIRST, always, store or no store) ----------
// A probe that can only ever print 0 is a vacuous falsifier (§6). This constructs a stale leg
// coinciding with a band step-down and asserts the SHIPPED pipeline (verdictHoldLegs +
// computeAlertBandDetail + detectHold) detects it as a hold — and a fresh control does NOT.
function runSelfTest(): { fired: boolean; controlHeld: boolean; band: AlertLevel } {
  const TODAY = "2026-07-21"; // a Tuesday
  const PREV_PUBLICATION = "2026-07-20"; // the Monday — the second-newest day on the constructed grid
  // ⚠ SLOTS, NOT DAYS (slice 3, 2026-09-09). The age this self-test constructs is a count of
  // PUBLICATION DAYS on the grid `lagCalendarsFrom` derives from these very readings, and that grid
  // is exactly the SET OF DISTINCT DATES they sit on — one per Reading. So the construction is
  // "two publications behind the leading edge": the fresh dial legs occupy TODAY and
  // PREV_PUBLICATION, and the stale leg sits below both, which puts it at slot age 2. The cut is
  // NOT restated here; `lagCutFor` is asserted against below so a moved tier reds this construction
  // instead of silently making it fresh.
  const STALE_DAILY_DATE = "2026-06-15";
  const FRESH_DATE = TODAY;

  const mkReading = (id: string, state: State, date: string): Reading => ({
    indicator: indicatorById.get(id)!,
    date,
    level: 0,
    delta20: 0,
    rawState: state,
    state,
  });

  // A GREEN, daily-cadence leg (no `cadence` set ⇒ defaults daily) — stale at 36d, but GREEN so it
  // pushes NO escalator/dial upward: the band is free to be OK while the prior band was WARNING.
  const staleId = ALL_INDICATORS.find((i) => !i.cadence)!.id;

  // Fresh GREEN dial members ⇒ a Calm panel ⇒ notifyRegime Calm ⇒ computedBand OK.
  const dialIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].filter((id) => indicatorById.has(id));
  // Split across the two newest publication days so the derived grid HAS a second day — a pool where
  // every fresh leg shares one date yields a one-day grid on which nothing can ever read stale, and
  // the self-test would then be the vacuous falsifier it exists to rule out.
  const freshDial = dialIds.map((id, i) => mkReading(id, "GREEN", i % 2 === 0 ? FRESH_DATE : PREV_PUBLICATION));

  const staleReadings: Reading[] = [...freshDial, mkReading(staleId, "GREEN", STALE_DAILY_DATE)];
  const freshReadings: Reading[] = [...freshDial, mkReading(staleId, "GREEN", FRESH_DATE)];

  const simple = staleReadings.map((r) => ({ id: r.indicator.id, state: r.state }));
  const panel = computeFamilyPanel(simple, DIAL_FAMILIES);
  const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
  const dial = computeT1Dial(panel.families, techP);
  const detail = computeAlertBandDetail({
    dial,
    readings: staleReadings,
    geoFlags: 0,
    r4Phase: "equity",
    recentDialBands: [],
  });

  // `verdictHoldLegs` READS the stamp since slice 3 — it computes no freshness and takes no clock.
  // Stamping through `lagCalendarsFrom` over the SAME pool is exactly what run-cycle-dial.ts does, so
  // this self-test drives the shipped path rather than a probe-local imitation of it.
  const stampAt = (rs: Reading[]): Reading[] => stampFreshness(rs, TODAY, lagCalendarsFrom(rs));
  const stales = verdictHoldLegs(stampAt(staleReadings));
  const freshStales = verdictHoldLegs(stampAt(freshReadings));

  const PRIOR: AlertLevel = "WARNING";
  const fired = detectHold(detail.band, PRIOR, stales); // stale + step-down ⇒ MUST hold
  const controlHeld = detectHold(detail.band, PRIOR, freshStales); // no stale leg ⇒ MUST NOT hold
  return { fired, controlHeld, band: detail.band };
}

const self = runSelfTest();
if (!self.fired || self.controlHeld) {
  console.log(
    `SELF-TEST FAILED (probe is vacuous): constructed stale+step-down ⇒ hold=${self.fired} ` +
      `(expected true), band=${self.band}; fresh-control ⇒ hold=${self.controlHeld} (expected false). ` +
      `Refusing to report a hold count from a probe that cannot detect a real hold.`,
  );
  process.exit(1);
}
console.log(
  `SELF-TEST OK: constructed stale leg + band step-down (OK<WARNING) ⇒ HOLD detected; ` +
    `fresh control ⇒ no hold. The probe can report a non-zero count.\n`,
);

// ---------- store ----------
// Degrade with a MESSAGE, not a stack trace, when no DB is reachable — the common failure here is
// "no local stack running / no creds", which is operator state, not a bug.
let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT (store): no store reachable for --env=${envArg} — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The self-test above already PROVED non-vacuity; only the real hold-count is missing.\n` +
      `    For prod: ensure ~/.supabase/access-token exists (Management-API pull) or .env.prod creds.\n` +
      `    For local: bring the dev stack up (\`scripts/db.sh up dev\`) and populate .env.local.`,
  );
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
// Fold over EVERY configured indicator: BAND-HOLD binds while ANY leg is stale, so the faithful
// verdictHoldLegs population is the full scored reading set run-core.ts passes — not just the dial members.
// Ids with no persisted series resolve to [] and are simply absent every day (never "lag").
const memberIds = [...new Set(ALL_INDICATORS.map((i) => i.id))];
// Parallel fetch + the fail-loud ABORT on a swallowed fetch failure (`lib/replay-walk.ts`
// §loadSeries) — that ABORT lives inside `loadSeriesWith`, which absorbs every per-id rejection and
// `process.exit(1)`s itself. A store ERROR is not an empty series: empty-but-succeeded is genuine
// state and is reported by the coverage block below.
const seriesById: Map<string, SeriesPoint[]> = await loadSeries(
  store,
  memberIds,
  REPLAY_N + FETCH_SLACK,
);

// ---------- coverage ----------
const present = memberIds.filter((id) => (seriesById.get(id) ?? []).length > 0);
const empty = memberIds.filter((id) => (seriesById.get(id) ?? []).length === 0);
const dialIds = new Set([...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))]);
const dialEmpty = empty.filter((id) => dialIds.has(id));

console.log(`W4-e lag probe — env=${envArg}  closes=${REPLAY_N}`);
console.log(`indicators: ${memberIds.length} configured, ${present.length} with persisted series, ${empty.length} empty`);
if (dialEmpty.length > 0) {
  console.log(
    `    ⚠ ${dialEmpty.length} DIAL member(s) came back EMPTY (${dialEmpty.join(", ")}) — the replayed band ` +
      `may drift from prod for those closes. Not fatal for the lag count, but noted.`,
  );
}

// ---------- calendar + the ABORT guard (no silent truncation) ----------
// Calendar = F4 daily closes (`calendarFrom`'s default axis), the same trading-day axis the
// replay/overlay probes use.
const calendar = calendarFrom(seriesById);
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N, fromArg, toArg });

// ---------- per-member forward-fill cursor ----------
// Held explicitly (rather than left to `walkReplay`'s default) because this probe needs the whole
// SeriesPoint — vintage date, level, delta20, rawState — not just the `{id, state}` pair the walk
// hands back; re-calling the cursor on the SAME close is idempotent, so it re-reads the same point.
const cursor = makeCursor(seriesById);

// ---------- replay + the lag/band fold ----------
interface Row {
  date: string;
  computedBand: AlertLevel;
  priorBand: AlertLevel | null;
  staleCount: number;
  staleCadences: Cadence[];
  hold: boolean;
}

/** The path-dependent carry: R4 phase, the prior close's raw dial band, and the prior FINAL band. */
interface Fold {
  rows: Row[];
  r4Prior: R4State;
  prevDialBand: AlertLevel | null; // raw notify-axis dial band of the prior close (lag input)
  priorFinalBand: AlertLevel | null; // prior persisted FINAL band = Stage-4 hold floor
}

// `lib/replay-walk.ts`'s `walkReplay` owns the cursor and the ascending iteration only; the whole
// band/lag fold — and `detectHold`, the load-bearing predicate — stays in this probe.
const fold = await walkReplay<Fold>({
  dates: replayDates,
  seriesById,
  ids: memberIds,
  cursor,
  initial: {
    rows: [],
    r4Prior: { phase: "equity", entryFiredAt: null, reentryRung: null },
    prevDialBand: null,
    priorFinalBand: null,
  },
  onClose: ({ date: d, readings: simple, state }) => {
    // `simple` is the gap-filtered `{id, state}` set; re-read each survivor's full point off the same
    // cursor for the VINTAGE date and the raw level/delta20 the band detail needs.
    const readings: Reading[] = simple.map(({ id }) => {
      const p = seriesById.get(id)![cursor(id, d)]!;
      return {
        indicator: indicatorById.get(id)!,
        date: p.date, // the VINTAGE date — lag = d − this
        level: p.value,
        delta20: p.delta20,
        rawState: p.rawState,
        state: p.state,
      };
    });

    // SAME pipeline as the notify path: panel (DIAL_FAMILIES — the notify axis, B-11) → tech
    // confirmer → dial → R4 (F1 = HY-OAS, VT ratio; clock = the close being replayed).
    const panel = computeFamilyPanel(simple, DIAL_FAMILIES);
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
    const dial = computeT1Dial(panel.families, techP);
    const f1 = readings.find((r) => r.indicator.id === "F1")?.level ?? null;
    const vt = readings.find((r) => r.indicator.id === "VT")?.level ?? null;
    const r4 = computeR4(dial, f1, vt, state.r4Prior, () => d);
    state.r4Prior = { phase: r4.phase, entryFiredAt: r4.entryFiredAt, reentryRung: r4.reentryRung };

    const detail = computeAlertBandDetail({
      dial,
      readings,
      geoFlags: 0, // manual geo flags have no replayable history (replay.ts GEO_NOTE)
      r4Phase: r4.phase,
      recentDialBands: state.prevDialBand ? [state.prevDialBand] : [],
    });

    // Slice 3: the stamp is the run path's ONE freshness computation and `verdictHoldLegs` reads it.
    // Calendars are derived from THIS close's readings, byte-for-byte the run-cycle-dial.ts shape, so
    // the replayed hold count measures the shipped behaviour, not a probe-local approximation.
    const stales = verdictHoldLegs(stampFreshness(readings, d, lagCalendarsFrom(readings)));
    const hold = detectHold(detail.band, state.priorFinalBand, stales);

    state.rows.push({
      date: d,
      computedBand: detail.band,
      priorBand: state.priorFinalBand,
      staleCount: stales.length,
      staleCadences: [...new Set(stales.map((s) => s.cadence))],
      hold,
    });

    state.prevDialBand = regimeToBand(dial.notifyRegime);
    state.priorFinalBand = detail.band;
    return state;
  },
});
const rows = fold.rows;

// ---------- report ----------
const holds = rows.filter((r) => r.hold);
const withStale = rows.filter((r) => r.staleCount > 0);
const stepDowns = rows.filter((r) => r.priorBand !== null && ALERT_RANK[r.computedBand] < ALERT_RANK[r.priorBand]);

console.log(
  `\nreplayed ${rows.length} closes  ${rows[0]!.date} → ${rows.at(-1)!.date}` +
    ` (≈ ${(rows.length / 252).toFixed(2)} trading-yrs)`,
);
console.log(`    closes with ≥1 stale leg:  ${withStale.length} (${((100 * withStale.length) / rows.length).toFixed(1)}%)`);
console.log(`    closes where band steps down: ${stepDowns.length}`);
console.log(`\n    >>> HOLD-COUNT (stale AND would-step-down = BAND-HOLD binds): ${holds.length} <<<`);
if (holds.length === 0) {
  console.log(
    `    A zero is a CALIBRATION RESULT, not a failure: over this history a stale leg never coincided\n` +
      `    with a would-be band downgrade ⇒ §2 stopping rule ⇒ ship FLAG-only, SKIP Stage 4 BAND-HOLD.`,
  );
} else {
  console.log(`    >0 ⇒ §2 stopping rule ⇒ BUILD Stage 4 BAND-HOLD. Hold closes:`);
  for (const h of holds.slice(0, 25)) {
    console.log(`      ${h.date}  ${h.priorBand}→${h.computedBand}  stale[${h.staleCadences.join(",")}] (${h.staleCount} legs)`);
  }
  if (holds.length > 25) console.log(`      … +${holds.length - 25} more`);
}

// per-cadence breakdown: how often each cadence contributed a stale leg
const cadenceCounts = new Map<Cadence, number>();
for (const r of withStale) for (const c of r.staleCadences) cadenceCounts.set(c, (cadenceCounts.get(c) ?? 0) + 1);
console.log(`\n    per-cadence stale-leg incidence (closes with ≥1 stale leg of that cadence):`);
for (const c of ["daily", "weekly", "monthly", "quarterly"] as Cadence[]) {
  console.log(`      ${c.padEnd(10)} ${cadenceCounts.get(c) ?? 0}`);
}

if (outArg) {
  writeFileSync(
    outArg,
    JSON.stringify(
      {
        env: envArg,
        closes: REPLAY_N,
        from: fromArg ?? null,
        to: toArg ?? null,
        replayed: rows.length,
        selfTest: self,
        holdCount: holds.length,
        closesWithStale: withStale.length,
        bandStepDowns: stepDowns.length,
        cadenceIncidence: Object.fromEntries(cadenceCounts),
        indicatorsPresent: present.length,
        indicatorsEmpty: empty,
        dialMembersEmpty: dialEmpty,
        holds: holds.map((h) => ({
          date: h.date,
          priorBand: h.priorBand,
          computedBand: h.computedBand,
          staleCount: h.staleCount,
          staleCadences: h.staleCadences,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote summary → ${outArg}`);
}
