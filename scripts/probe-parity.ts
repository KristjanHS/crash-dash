/**
 * Stored-vs-recomputed STATE parity probe — ONE probe for every id with a parity arm
 * (round-3 A3). Replaces the ex-`probe-restate-agreement`
 * (F3/F9/F11), the F6 wrapper and `probe-fxh-leg-parity`.
 *
 *   npm run probe:parity -- --env=prod                    # every DEFAULT_IDS arm
 *   npm run probe:parity -- --id F9 --env=prod --closes 1500
 *   npm run probe:parity -- --id FXH --env=prod
 *
 * THE SEAM (never re-implemented here) is, per arm, exactly the scorer the cron persists through:
 *   fred   — any `INDICATORS` member: the stored vintage → `synthesizedCalib` (split-brain guard) →
 *            `resolveCuts` → `indicatorReadingSeries` (`scoreWithCuts`/`backfillAll`'s `cutsFor` route).
 *   ratio  — F6: the stored `value` IS the SMH/SPY ratio the scorer persists as `level`; with the
 *            denominator pinned to 1 the ratio map is the identity, so `relStrengthBreakReadingSeries`
 *            runs the MA200 spread, the null-amber guard and the confirm fold as prod runs them.
 *   fxlegs — FXH: `havenLegs` is NOT a stored column — the three stored `CMP_FXH_*` leg closes go through
 *            `fxHavenReadingSeries` (worst-of move → `fxHavenState` → `resolveBands` cuts → the confirm
 *            fold), so stored CONFIRMED state is compared to recomputed CONFIRMED state. The ex-probe
 *            compared raw-vs-confirmed and had to grade a ≤2-close asymmetry by hand; this arm has none.
 * Every arm re-derives from stored rows — no feed re-fetch — so the probe's OWN two arms cannot drift on a
 * data revision. ⚠ Reads the `readings` table directly, NEVER `/api/series`: a `Cache-Control: no-cache`
 * REQUEST header does not bust Vercel's edge `s-maxage` (`research-probes.md` §The instrument is a claim too).
 *
 * INPUT-SOURCE ASYMMETRY (why the % is a gate, not a line-by-line prediction): `npm run restate` →
 * `backfillAll` re-FETCHES the primary feed and scores off fresh closes, whereas this probe re-derives from
 * the stored `readings.value`. The post-restate 100% still holds — restate rewrites value+state atomically —
 * but a historical feed revision landing between the stored vintage and the restate's fetch means a
 * pre-restate drift % is NOT a strict per-row prediction of the restate's output.
 *
 * PRE-REGISTERED EXPECTATION: 100% on every id AFTER its restate; a non-100% is the expected pre-restate
 * state and the evidence the restate is still owed — the prod re-score after a cut retune (`--restate=<id>`, dry first), then re-run.
 *
 * MEMBERSHIP DRIFT (live, load-bearing): only F3 is still a `synthPriors` id; F9 left the seam 2026-08-08
 * and F11 2026-08-09 (`SYNTH_PRIOR_IDS`, domain-cuts.ts). Their live cut is now the registry σ-leg, which
 * `resolveCuts`/`indicatorReadingSeries` still recompute — only F3's synth-degrade vacuity guard applies.
 *
 * EXIT 1 when any id is below 100% agreement, has no parity arm, or its recomputation is VACUOUS (fewer
 * than MIN_COMPARED compared closes, or a synthPriors id whose synth history degraded so the diff is
 * against the fallback, not the live cut). Read-only: `getSeries`, `getSeriesBulk` and `getCalibration`.
 */
import { INDICATORS } from "../src/registry-fred.js";
import { indicatorReadingSeries } from "../src/scorers-core.js";
import { resolveCuts } from "../src/domain-cuts.js";
import type { Observation } from "../src/domain-types.js";
import { hasSynthPriors } from "../src/domain-cuts.js";
import { type State } from "../src/domain-types.js";
import { synthesizedCalib, loadSynthHistories, synthCutsDegraded, type SynthHistories } from "../src/synth-cuts.js";
import { F6 } from "../src/registry-price.js";
import { FXH } from "../src/registry-composite.js";
import { relStrengthBreakReadingSeries } from "../src/scorers-price.js";
import { fxHavenReadingSeries } from "../src/scorers-composite.js";
import { CHART_DESCRIPTOR_OF } from "../src/family-descriptor-rows.js";
import { VELOCITY_WINDOW } from "../src/domain-types.js";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import type { ReadStore, SeriesPoint } from "../src/store.js";
import { pathToFileURL } from "node:url";

/** The three ex-restate-agreement ids plus every non-fred arm — the no-`--id` roster. */
export const DEFAULT_IDS = ["F3", "F9", "F11", "F6", "FXH"] as const;
/** Deep enough to burn the scorer warmup before the newest-`closes` comparison window (probe-f11-horizon precedent). */
const FETCH_LIMIT = 20_000;
/** Below this many compared closes the agreement % is vacuous (the ex-F6 wrapper's floor). */
export const MIN_COMPARED = 200;

export type ArmKind = "fred" | "ratio" | "fxlegs";

/** Per-arm live recomputation over STORED rows: returns date → recomputed confirmed state, plus the stored FXH/F6/fred points. */
interface ArmContext {
  store: ReadStore;
  vintage: Awaited<ReturnType<ReadStore["getCalibration"]>>;
  histories: SynthHistories;
}
interface ArmResult {
  stored: SeriesPoint[];
  live: Map<string, State>;
  /** Only the fred arm can be synth-degraded; the others never are. */
  synthDegraded: boolean;
  seam: string;
}
type Arm = (id: string, ctx: ArmContext) => Promise<ArmResult>;

const readingsToMap = (rs: ReadonlyArray<{ date: string; state: State }>): Map<string, State> =>
  new Map(rs.map((r) => [r.date, r.state]));

const fredArm: Arm = async (id, { store, vintage, histories }) => {
  const ind = INDICATORS.find((i) => i.id === id)!; // routed only for members (see armFor)
  const stored = await store.getSeries(id, FETCH_LIMIT);
  const observations: Observation[] = stored.map((p) => ({ date: p.date, value: p.value }));
  const cuts = resolveCuts(ind.id, synthesizedCalib(ind, vintage, histories), ind.direction ?? "HIGH");
  return {
    stored,
    live: readingsToMap(indicatorReadingSeries(ind, observations, cuts)),
    synthDegraded: synthCutsDegraded(ind, histories),
    seam: hasSynthPriors(id) ? "synth" : "registry-σ",
  };
};

const ratioArm: Arm = async (id, { store }) => {
  if (id !== F6.id) throw new Error(`ratio arm is F6-only (got ${id}) — a second RS id needs its own cuts, not F6's`);
  const stored = await store.getSeries(id, FETCH_LIMIT);
  const ratio: Observation[] = stored.map((p) => ({ date: p.date, value: p.value }));
  const ones: Observation[] = stored.map((p) => ({ date: p.date, value: 1 }));
  return { stored, live: readingsToMap(relStrengthBreakReadingSeries(F6, ratio, ones)), synthDegraded: false, seam: "rs-ratio" };
};

const fxLegsArm: Arm = async (id, { store }) => {
  // Same leg roster + same depth padding api/series.ts' fxHavenSeries uses: the first VELOCITY_WINDOW
  // aligned days have no lookback, and the pad absorbs calendar misalignment across the legs.
  const legIds = CHART_DESCRIPTOR_OF.FXH!.seriesIds!;
  const bySeries = await store.getSeriesBulk([...legIds], { limit: FETCH_LIMIT + VELOCITY_WINDOW + 10 });
  const toObs = (legId: string): Observation[] => (bySeries.get(legId) ?? []).map((p) => ({ date: p.date, value: p.value }));
  const legs = legIds.map(toObs);
  const stored = await store.getSeries(id, FETCH_LIMIT);
  const live = readingsToMap(fxHavenReadingSeries(FXH, legs[0]!, legs[1]!, legs[2]!));
  return { stored, live, synthDegraded: false, seam: `fx-legs(${legIds.map((l, i) => `${l}:${legs[i]!.length}`).join(" ")})` };
};

const ARMS: Readonly<Record<ArmKind, Arm>> = { fred: fredArm, ratio: ratioArm, fxlegs: fxLegsArm };

/** Which arm scores `id`, or null when no parity arm exists for it (the loud-abort case). */
export function armFor(id: string): ArmKind | null {
  if (id === F6.id) return "ratio";
  if (id === FXH.id) return "fxlegs";
  if (INDICATORS.some((i) => i.id === id)) return "fred";
  return null;
}

export interface AgreementTally {
  /** Stored dates that also scored a live state (the denominator). */
  compared: number;
  agreed: number;
  /** "STORED→LIVE" → count, only for disagreeing closes. */
  mismatches: Map<string, number>;
}

/**
 * Pure agreement tally: for every stored date that ALSO scored a live state, count agreement and
 * bucket each disagreement by its `stored→live` state pair. A stored date the live series never
 * reached (below warmup) is NOT a mismatch and NOT compared — it drops out of the denominator.
 */
export function tallyAgreement(stored: ReadonlyMap<string, State>, live: ReadonlyMap<string, State>): AgreementTally {
  let compared = 0;
  let agreed = 0;
  const mismatches = new Map<string, number>();
  for (const [date, s] of stored) {
    const l = live.get(date);
    if (l === undefined) continue;
    compared += 1;
    if (l === s) agreed += 1;
    else {
      const key = `${s}→${l}`;
      mismatches.set(key, (mismatches.get(key) ?? 0) + 1);
    }
  }
  return { compared, agreed, mismatches };
}

/**
 * Anti-vacuity guard: a named reason the agreement number is not real, or null when it is. Fewer than
 * MIN_COMPARED compared closes is vacuous; a `synthPriors` id whose synth history degraded scored the live
 * arm against the registry prior, so the diff is against the fallback — the exact defect being repaired,
 * never a passing 0/0.
 */
export function vacuityReason(args: { id: string; compared: number; isSynth: boolean; synthDegraded: boolean }): string | null {
  if (args.compared === 0)
    return `zero compared closes — no stored ${args.id} date scored a live state (coverage 0 / recomputation vacuous)`;
  if (args.compared < MIN_COMPARED)
    return `only ${args.compared} compared closes (< ${MIN_COMPARED}) — the ${args.id} arm is too thin to gate on`;
  if (args.isSynth && args.synthDegraded)
    return `${args.id} synth-cut history degraded/absent — the live arm fell back to the registry prior, so the diff is against the fallback, not the live percentile cut`;
  return null;
}

/** Max calendar-day gap between consecutive stored dates — the forward-fill age a stale close would sit at. */
export function maxGapDays(dates: readonly string[]): number {
  let max = 0;
  for (let i = 1; i < dates.length; i++) {
    const d = (Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)) / 86_400_000;
    if (d > max) max = d;
  }
  return max;
}

export interface ProbeArgs {
  ids: string[];
  env: "local" | "prod";
  closes: number;
}

/** Discriminated reject: a bad flag returns this (message identical to the old inline abort) instead of exiting. */
export interface ParseError {
  error: string;
}

/** `--id`/`--closes` accept both `--k v` and `--k=v`; `--env=dev` aliases local. Defaults to DEFAULT_IDS. */
export function parseArgs(argv: readonly string[]): ProbeArgs | ParseError {
  const val = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const idArg = val("id");
  const rawEnv = val("env") ?? "prod";
  const env = rawEnv === "prod" ? "prod" : rawEnv === "dev" || rawEnv === "local" ? "local" : null;
  if (env === null) return { error: `ABORT: --env must be prod|dev|local (got ${rawEnv}).` };
  const closesArg = val("closes");
  const closes = closesArg === undefined ? 1500 : Number(closesArg);
  if (!Number.isInteger(closes) || closes <= 0) return { error: `ABORT: --closes must be a positive integer (got ${closesArg}).` };
  return { ids: idArg ? [idArg] : [...DEFAULT_IDS], env, closes };
}

export async function runProbe(store: ReadStore, args: ProbeArgs): Promise<number> {
  const vintage = await store.getCalibration().catch(() => []);
  const histories = await loadSynthHistories(store);
  const ctx: ArmContext = { store, vintage, histories };
  let failed = false;

  for (const id of args.ids) {
    const kind = armFor(id);
    if (kind === null) {
      console.error(`ABORT ${id}: no parity arm — not an INDICATORS member and not ${F6.id}/${FXH.id}.`);
      failed = true;
      continue;
    }
    const { stored, live, synthDegraded, seam } = await ARMS[kind](id, ctx);

    // The newest `closes` stored dates — the same convention as the e8 falsifier's "newest 1500".
    const window = stored.slice(-args.closes);
    const storedStates = new Map<string, State>(window.map((p) => [p.date, p.state]));
    const tally = tallyAgreement(storedStates, live);

    const isSynth = hasSynthPriors(id);
    const vacuous = vacuityReason({ id, compared: tally.compared, isSynth, synthDegraded });

    const span = window.length > 0 ? `${window[0]!.date}..${window.at(-1)!.date}` : "(empty)";
    const dates = window.map((p) => p.date);
    const newestAge = window.length > 0 ? Math.round((Date.now() - Date.parse(window.at(-1)!.date)) / 86_400_000) : 0;
    // Window counts stored rows; the AGREEMENT denominator is `compared` — the below-warmup head the live
    // series never reached drops out. Annotate the delta so "window 769" over a 749 denominator reads clean.
    const warmupDrop = window.length - tally.compared;
    console.log(
      `COVERAGE ${id}: ${stored.length} stored row(s), window ${window.length}${warmupDrop > 0 ? ` (−${warmupDrop} warmup)` : ""} (${span}) · arm=${kind} seam=${seam} · ` +
        `synthDegraded=${synthDegraded} · maxGap ${maxGapDays(dates)}d · newest ${newestAge}d old`,
    );

    if (vacuous !== null) {
      console.error(`VACUOUS ${id}: ${vacuous}.`);
      failed = true;
      continue;
    }

    const pct = ((tally.agreed / tally.compared) * 100).toFixed(1);
    console.log(`AGREEMENT ${id}: ${tally.agreed}/${tally.compared} (${pct}%)`);
    if (tally.mismatches.size > 0) {
      const breakdown = [...tally.mismatches.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`);
      console.log(`  MISMATCH ${id}: ${breakdown.join(", ")}`);
    }
    if (tally.agreed !== tally.compared) failed = true;
  }

  if (failed) {
    console.error(
      "[probe:parity] below-100% agreement, a vacuous arm, or an id without an arm — the pre-restate state, or a real drift. " +
        "the prod re-score after a cut retune (`--restate=<id>`, dry first), then re-run.",
    );
    return 1;
  }
  console.log("[probe:parity] every id's stored state matches its live scorer seam (100%).");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.log(parsed.error);
    process.exit(1);
  }
  const store = await resolveStore(parsed.env, "ro", liveResolveDeps);
  process.exit(await runProbe(store, parsed));
}
