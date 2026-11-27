/**
 * Bubble-arming K1/K2 sweep — the
 * pre-registered measured pre-step: replay the fast band over stored history, compute the slow
 * bubble band per day from the PERSISTED slow-track rows, and count how each candidate
 * armed-conditioning would have moved the band / the pushes vs the shipped baseline.
 *
 *   bash scripts/with-prod-config.sh tsx scripts/probe-armed-shift.ts --env=prod                      # prod (the prod config), read-only
 *   bash scripts/with-prod-config.sh tsx scripts/probe-armed-shift.ts --env=prod --closes=1500 --out=/tmp/armed-shift.json
 *
 * ARMED := computeSlowVerdict(components).band !== "CALM", where the per-day component scores
 * are decoded from the persisted `price-accel` / `complacency-vix` / `complacency-high` states
 * (backfill-slow seeds them point-in-time with the live windows; state IS scoreToState(score),
 * so no re-scoring and no window drift — the store rows are the slow track's own vintage).
 *
 * Candidates, applied ONLY on armed days (unarmed days always run the shipped constants):
 *   K2a/K2b — de-escalation lag `n` 2 → 4 / 5 (`computeAlertBandDetail`'s existing `n` param).
 *   K1a/K1b — NOTIFY escalation cuts ×0.90 / ×0.85: `notifyRegimeFor(dial.dangerScore / f)`
 *             ≡ every NOTIFY_REGIME_CUTS boundary scaled ×f (score < c·f ⟺ score/f < c),
 *             re-gated through the SHIPPED `applyCrisisGate`. The escalator FLOORS carry no
 *             scalable numeric cut on this replay: credit/r4/ew are state/boolean predicates,
 *             geo is an integer count (left alone by ruling), and RATE_STRESS_FLOOR=2 over an
 *             integer channelScore is inert under ×0.90/×0.85 (⌈1.8⌉=⌈1.7⌉=2) — so the concrete
 *             K1 form is the notify-cut scaling the plan names for alert-band.ts/t1dial.ts.
 *   K1c     — K1a + K2a combined.
 *
 * The per-close pipeline mirrors `scripts/probe-lag-cuts.ts` (itself the shared
 * `lib/replay-walk.ts` fold): SHIPPED computeFamilyPanel → computeT1Dial → computeR4 →
 * computeAlertBandDetail — imported, never re-derived. Divergence bump + geo flags/stage have
 * no replayable history and stay off, identically in every arm (baseline included).
 *
 * ⚠ **STRICTLY READ-ONLY:** `getSeries` selects only — never insert/update/delete/upsert.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { computeFamilyPanel, notifyRegimeFor, type FamilyKey, type FamilyPanel } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import {
  applyCrisisGate,
  computeT1Dial,
  techConfirmerBreadth,
  techConfirmerFromPanel,
  type T1DialResult,
} from "../src/t1dial.js";
import { computeR4, type R4Phase, type R4State } from "../src/r4.js";
import { computeAlertBandDetail, deEscalationLag, regimeToBand, DE_ESCALATION_DAYS } from "../src/alert-band.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { ALERT_RANK, decideNotify, type AlertLevel } from "../src/ladder.js";
import { computeSlowVerdict, type SlowComponent } from "../src/slow.js";
import type { Reading, State } from "../src/domain-types.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { loadSeries, makeCursor, calendarFrom, selectReplayDates, walkReplay, ffillReadings } from "./lib/replay-walk.js";
import type { SeriesPoint } from "../src/store.js";

// ---------- args ----------

/** ~6 trading years, matching probe:lag-cuts / probe:cash-overlay. */
const DEFAULT_CLOSES = 1500;
const REPLAY_N = Number(argOf("closes") ?? DEFAULT_CLOSES);
const envArg = envArgOf("local");
const fromArg = argOf("from");
const toArg = argOf("to");
const outArg = argOf("out");

/** Warm-up/pre-history slack per member read, matching probe:lag-cuts. */
const FETCH_SLACK = 400;

if (!Number.isFinite(REPLAY_N) || REPLAY_N < 1) {
  console.log(`ABORT: --closes must be a positive integer (got ${argOf("closes")}).`);
  process.exit(1);
}

// ---------- candidates ----------

interface Candidate {
  key: string;
  label: string;
  /** notify-cut scale on armed days (1 = shipped cuts). */
  f: number;
  /** de-escalation lag on armed days (shipped = DE_ESCALATION_DAYS). */
  n: number;
}

const CANDIDATES: Candidate[] = [
  { key: "K2a", label: "de-esc lag 2→4 (armed)", f: 1, n: 4 },
  { key: "K2b", label: "de-esc lag 2→5 (armed)", f: 1, n: 5 },
  { key: "K1a", label: "notify cuts ×0.90 (armed)", f: 0.9, n: DE_ESCALATION_DAYS },
  { key: "K1b", label: "notify cuts ×0.85 (armed)", f: 0.85, n: DE_ESCALATION_DAYS },
  { key: "K1c", label: "×0.90 + lag 2→4 (armed)", f: 0.9, n: 4 },
];

/** Raw-dial-band history depth each arm carries: max candidate n − 1. */
const RECENT_KEEP = Math.max(...CANDIDATES.map((c) => c.n)) - 1;

// ---------- the armed-conditioning transforms (reused by fold AND self-test) ----------

/** The K1 transform: shipped notify fold at cuts ×f, via score/f (exact — strict `<` both sides). */
function scaledNotifyRegime(dangerScore: number, f: number, creditFiring: boolean, volatilityFiring: boolean) {
  return applyCrisisGate(notifyRegimeFor(dangerScore / f), creditFiring, volatilityFiring);
}

/** Decode a persisted slow-leg state back to its 0–2 score (inverse of slow.ts `scoreToState`). */
const SLOW_SCORE: Record<State, 0 | 1 | 2> = { GREEN: 0, AMBER: 1, RED: 2 };

/** The SCORED slow set from the three persisted observability legs → armed bit. */
function armedFromSlowStates(pa: State, vix: State, high: State): boolean {
  const components: SlowComponent[] = [
    { id: "price-accel", label: "Price acceleration", score: SLOW_SCORE[pa] },
    { id: "complacency", label: "Complacency", score: (SLOW_SCORE[vix] + SLOW_SCORE[high]) as 0 | 1 | 2 },
  ];
  return computeSlowVerdict(components).band !== "CALM";
}

// ---------- NON-VACUITY SELF-TEST (runs FIRST, store or no store) ----------
// Each mechanism must be ABLE to move a band, and the f=1 control must be an identity —
// otherwise every candidate column is structurally zero and the sweep is vacuous.
function runSelfTest(): string | null {
  // K2: a dropped dial band held longer under n=4 than n=2 (recent = [yesterday OK, WARNING before]).
  if (deEscalationLag("OK", ["OK", "WARNING"], 2) !== "OK") return "K2: n=2 should release to OK";
  if (deEscalationLag("OK", ["OK", "WARNING"], 4) !== "WARNING") return "K2: n=4 should still hold WARNING";
  // K1: a dangerScore just under the caution cut escalates under ×0.90 and not under ×1.
  const justUnder = 0.24; // caution cut = rungCut(3) = 0.25
  if (scaledNotifyRegime(justUnder, 1, false, false) !== "Calm") return "K1 control: f=1 must be identity";
  if (scaledNotifyRegime(justUnder, 0.9, false, false) !== "Caution") return "K1: ×0.90 must escalate 0.24";
  // K1 equivalence: score/f vs cut·f agree on both sides of the boundary.
  for (const s of [0.2, 0.224, 0.226, 0.3]) {
    if (s / 0.9 >= 0.25 !== (s >= 0.25 * 0.9)) return `K1 equivalence broke at score=${s}`;
  }
  // ARMED decode: [1,1] → ELEVATED (ratio 0.5) arms; all-green stays CALM.
  if (!armedFromSlowStates("AMBER", "AMBER", "GREEN")) return "armed: PA=1 + vix=1 must arm (ratio 0.5)";
  if (armedFromSlowStates("GREEN", "GREEN", "GREEN")) return "armed: all-green must stay CALM";
  return null;
}

const selfErr = runSelfTest();
if (selfErr) {
  console.log(`SELF-TEST FAILED (probe is vacuous): ${selfErr}. Refusing to report a sweep.`);
  process.exit(1);
}
console.log(
  `SELF-TEST OK: K2 lag n=4 holds where n=2 releases; K1 ×0.90 escalates a just-under-cut score ` +
    `(f=1 identity holds); armed bit decodes from persisted slow states.\n`,
);

// ---------- store (read-only usage) ----------
let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT (store): no store reachable for --env=${envArg} — ${e instanceof Error ? e.message : String(e)}\n` +
      `    For prod: .env.prod creds (npm entry) or ~/.supabase/access-token.\n` +
      `    For local: bring the dev stack up (\`scripts/db.sh up dev\`) and populate .env.local.`,
  );
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
const indicatorById = new Map(ALL_INDICATORS.map((ind) => [ind.id, ind]));
const memberIds = [...new Set(ALL_INDICATORS.map((i) => i.id))];
const SLOW_IDS = ["price-accel", "complacency-vix", "complacency-high"] as const;

const seriesById: Map<string, SeriesPoint[]> = await loadSeries(
  store,
  [...memberIds, ...SLOW_IDS],
  REPLAY_N + FETCH_SLACK,
);

const empty = memberIds.filter((id) => (seriesById.get(id) ?? []).length === 0);
const slowEmpty = SLOW_IDS.filter((id) => (seriesById.get(id) ?? []).length === 0);
console.log(`armed-shift sweep — env=${envArg}  closes=${REPLAY_N}`);
console.log(`indicators: ${memberIds.length} configured, ${memberIds.length - empty.length} with persisted series, ${empty.length} empty`);
for (const id of SLOW_IDS) {
  const pts = seriesById.get(id) ?? [];
  console.log(`    slow ${id.padEnd(17)} ${String(pts.length).padStart(6)} rows   ${pts[0]?.date ?? "—"} → ${pts.at(-1)?.date ?? "—"}`);
}
if (slowEmpty.length > 0) {
  console.log(
    `ABORT: slow leg(s) [${slowEmpty.join(", ")}] have NO persisted history — the armed bit is ` +
      `undefined on every day and the sweep would be vacuous. Seed via backfill:slow first.`,
  );
  process.exit(1);
}

// ---------- calendar (F4 trading days, same axis as the sibling probes) ----------
const calendar = calendarFrom(seriesById);
const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N, fromArg, toArg });

const cursor = makeCursor(seriesById);

// ---------- per-arm fold state ----------
interface Arm {
  /** raw dial bands, most-recent first (this arm's own — K1 changes them on armed days). */
  recent: AlertLevel[];
  last: AlertLevel | null;
  bands: AlertLevel[]; // parallel to replayed dates
  pushDates: Set<string>;
}
const mkArm = (): Arm => ({ recent: [], last: null, bands: [], pushDates: new Set() });

interface Fold {
  dates: string[];
  armedByDay: boolean[];
  slowMissingDays: number;
  base: Arm;
  cands: Map<string, Arm>;
  r4Prior: R4State;
}

function stepArm(
  arm: Arm,
  date: string,
  dial: T1DialResult,
  scaledDial: T1DialResult | null,
  readings: Reading[],
  r4Phase: R4Phase,
  armed: boolean,
  cand: Candidate | null,
): void {
  const useScaled = armed && cand !== null && cand.f !== 1;
  const d = useScaled ? scaledDial! : dial;
  const n = armed && cand ? cand.n : DE_ESCALATION_DAYS;
  const band = computeAlertBandDetail({
    dial: d,
    readings,
    geoFlags: 0, // no replayable manual-flag/stage history (replay.ts GEO_NOTE)
    r4Phase,
    recentDialBands: arm.recent,
    n,
  }).band;
  arm.recent = [regimeToBand(d.notifyRegime), ...arm.recent].slice(0, RECENT_KEEP);
  if (decideNotify(arm.last, band).push) arm.pushDates.add(date);
  arm.last = band;
  arm.bands.push(band);
}

const fold = await walkReplay<Fold>({
  dates: replayDates,
  seriesById,
  ids: memberIds,
  cursor,
  initial: {
    dates: [],
    armedByDay: [],
    slowMissingDays: 0,
    base: mkArm(),
    cands: new Map(CANDIDATES.map((c) => [c.key, mkArm()])),
    r4Prior: { phase: "equity", entryFiredAt: null, reentryRung: null },
  },
  onClose: ({ date: d, readings: simple, state }) => {
    // Full Reading[] off the same cursor (vintage date + level/delta20) — probe-lag-cuts pattern.
    const readings: Reading[] = simple.map(({ id }) => {
      const p = seriesById.get(id)![cursor(id, d)]!;
      return { indicator: indicatorById.get(id)!, date: p.date, level: p.value, delta20: p.delta20, rawState: p.rawState, state: p.state };
    });

    // SHIPPED pipeline: panel → tech confirmer → dial → R4 (prior threaded sequentially).
    const panel = computeFamilyPanel(simple, DIAL_FAMILIES);
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
    const dial = computeT1Dial(panel.families, techP);
    const f1 = readings.find((r) => r.indicator.id === "F1")?.level ?? null;
    const vt = readings.find((r) => r.indicator.id === "VT")?.level ?? null;
    const r4 = computeR4(dial, f1, vt, state.r4Prior, () => d);
    state.r4Prior = { phase: r4.phase, entryFiredAt: r4.entryFiredAt, reentryRung: r4.reentryRung };

    // ARMED bit off the persisted slow legs (same cursor, same close, same ffill horizon).
    const slow = new Map(ffillReadings(seriesById, cursor, SLOW_IDS, d).map((r) => [r.id, r.state]));
    const slowComplete = SLOW_IDS.every((id) => slow.has(id));
    if (!slowComplete) state.slowMissingDays++;
    const armed = slowComplete && armedFromSlowStates(slow.get("price-accel")!, slow.get("complacency-vix")!, slow.get("complacency-high")!);

    // Crisis-gate facts, resolved exactly as computeT1Dial resolves them (live && firing).
    const isFiring = (k: FamilyKey, firingOf: (f: FamilyPanel) => boolean = (f) => f.firing) =>
      panel.families.some((fam) => fam.key === k && fam.live && firingOf(fam));
    // S4: the credit key reads its BAND role, exactly as computeT1Dial does.
    const creditFiring = isFiring("credit", (f) => f.band?.firing ?? f.firing);
    const volatilityFiring = isFiring("volatility");
    const scaledDialFor = (f: number): T1DialResult => ({
      ...dial,
      notifyRegime: scaledNotifyRegime(dial.dangerScore, f, creditFiring, volatilityFiring),
    });
    const scaledByF = new Map([...new Set(CANDIDATES.map((c) => c.f))].filter((f) => f !== 1).map((f) => [f, scaledDialFor(f)]));

    state.dates.push(d);
    state.armedByDay.push(armed);
    stepArm(state.base, d, dial, null, readings, r4.phase, false, null);
    for (const c of CANDIDATES) {
      stepArm(state.cands.get(c.key)!, d, dial, scaledByF.get(c.f) ?? null, readings, r4.phase, armed, c);
    }
    return state;
  },
});

// ---------- armed coverage ----------
const { dates, armedByDay } = fold;
const armedDays = armedByDay.filter(Boolean).length;

/** Contiguous true-runs over the replay axis → [start, end] date pairs. */
function episodesOf(mask: boolean[]): { start: string; end: string; days: number }[] {
  const eps: { start: string; end: string; days: number }[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const s = i;
    while (i + 1 < mask.length && mask[i + 1]) i++;
    eps.push({ start: dates[s]!, end: dates[i]!, days: i - s + 1 });
  }
  return eps;
}
const armedEpisodes = episodesOf(armedByDay);

console.log(`\nreplayed ${dates.length} closes  ${dates[0]} → ${dates.at(-1)}  (≈ ${(dates.length / 252).toFixed(2)} trading-yrs)`);
if (fold.slowMissingDays > 0) console.log(`    ⚠ ${fold.slowMissingDays} day(s) missing ≥1 slow leg — treated UNARMED (conservative).`);
console.log(`\nARMED coverage (slow band ≥ ELEVATED): ${armedDays}/${dates.length} days (${((100 * armedDays) / dates.length).toFixed(1)}%), ${armedEpisodes.length} episode(s):`);
for (const e of armedEpisodes) console.log(`    ${e.start} → ${e.end}  (${e.days} closes)`);

// ---------- per-candidate diff report ----------
const basePush = fold.base.pushDates;
console.log(`\nBASELINE: pushes=${basePush.size}  band-days  ${(["OK", "WATCH", "WARNING", "CRITICAL"] as AlertLevel[]).map((b) => `${b}:${fold.base.bands.filter((x) => x === b).length}`).join("  ")}`);

interface CandReport {
  key: string;
  label: string;
  daysDiff: number;
  higher: number;
  lower: number;
  pushes: number;
  pushesAdded: string[];
  pushesRemoved: string[];
  episodes: { start: string; end: string; days: number; sample: string }[];
}

const reports: CandReport[] = CANDIDATES.map((c) => {
  const arm = fold.cands.get(c.key)!;
  const diffMask = arm.bands.map((b, i) => b !== fold.base.bands[i]);
  const higher = arm.bands.filter((b, i) => ALERT_RANK[b] > ALERT_RANK[fold.base.bands[i]!]).length;
  const lower = arm.bands.filter((b, i) => ALERT_RANK[b] < ALERT_RANK[fold.base.bands[i]!]).length;
  const eps = episodesOf(diffMask).map((e) => {
    const i = dates.indexOf(e.start);
    return { ...e, sample: `${fold.base.bands[i]}→${arm.bands[i]}` };
  });
  eps.sort((a, b) => b.days - a.days);
  return {
    key: c.key,
    label: c.label,
    daysDiff: diffMask.filter(Boolean).length,
    higher,
    lower,
    pushes: arm.pushDates.size,
    pushesAdded: [...arm.pushDates].filter((d) => !basePush.has(d)).sort(),
    pushesRemoved: [...basePush].filter((d) => !arm.pushDates.has(d)).sort(),
    episodes: eps,
  };
});

console.log(`\ncand  ${"shift".padEnd(28)} days≠base  higher  lower  pushes  Δpush(+/−)`);
for (const r of reports) {
  console.log(
    `${r.key.padEnd(5)} ${r.label.padEnd(28)} ${String(r.daysDiff).padStart(9)}  ${String(r.higher).padStart(6)}  ${String(r.lower).padStart(5)}  ` +
      `${String(r.pushes).padStart(6)}  +${r.pushesAdded.length}/−${r.pushesRemoved.length}`,
  );
}

for (const r of reports) {
  if (r.daysDiff === 0) {
    console.log(`\n${r.key}: no band moved on any replayed day (inert over this window).`);
    continue;
  }
  console.log(`\n${r.key} largest diff episodes (base→cand at episode start):`);
  for (const e of r.episodes.slice(0, 5)) console.log(`    ${e.start} → ${e.end}  (${e.days}d)  ${e.sample}`);
  if (r.pushesAdded.length > 0) console.log(`    pushes added:   ${r.pushesAdded.join(", ")}`);
  if (r.pushesRemoved.length > 0) console.log(`    pushes removed: ${r.pushesRemoved.join(", ")}`);
}

if (outArg) {
  writeFileSync(
    outArg,
    JSON.stringify(
      {
        env: envArg,
        closes: REPLAY_N,
        window: { from: dates[0], to: dates.at(-1), days: dates.length },
        armed: { days: armedDays, pct: (100 * armedDays) / dates.length, episodes: armedEpisodes, slowMissingDays: fold.slowMissingDays },
        baseline: { pushes: basePush.size },
        candidates: reports,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote summary → ${outArg}`);
}
