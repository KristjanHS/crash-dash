/**
 * Stage-2 band_cuts parity probe (a retired plan).
 *
 *   npm run probe:band-cuts-parity            # local dev stack
 *   npm run probe:band-cuts-parity -- --env=prod --limit=60
 *
 * Falsifies the Stage-2 invariant "scored cut == drawn cut on every row": for CG, R1, R8 and F3 it
 * reads the newest `--limit` stored `readings.band_cuts` and re-scores each id off the SAME seam the
 * cron uses (CG: `cgRows` over fresh HG=F/GC=F closes fetched to `CG_LEVEL_ANCHOR`, the cron's anchored
 * base on either arm; R1/R8: `smoothedLevelReadingSeries` over the full-history feed;
 * F3: `synthCutSeries` over the stored level history), comparing per date at rel tol 1e-9.
 *
 * Two ways it fails (exit 1), plus the operational third:
 *   1. MISMATCH — a stored cut differs from the fresh re-score (or a stored key the re-score does not
 *      emit): the persisted number is not the number the scorer produces today.
 *   2. STORED-NULL — the fresh re-score has a finite cut but the row stored none: the draw path would
 *      fall back to a read-side recompute, the split-brain Stage 2 exists to kill. (R1 unarmed days
 *      are legitimately null on BOTH sides and count as neither.)
 *   3. A block that could not run (feed/store error) — an unrunnable falsifier is not a green one.
 *
 * Read-only: it never writes.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { cgLookbackDays, cgPoints, cgRows } from "../src/scorers-composite.js";
import { smoothedLevelReadingSeries } from "../src/scorers-core.js";
import {
  F3_VELOCITY_BAND,
  POINT_BAND_CUTS_OF,
  POST_INVERSION_BAND,
  R8_MEAN_CUT_BANDS,
  SMOOTHED_LEVEL_OF,
} from "../src/family-descriptor-rows.js";
import { fetchIndicatorObservations } from "../src/indicator-feed.js";
import { synthCutSeries, priorThresholds, SYNTH_VEL_WINDOW, SYNTH_HISTORY_LIMIT } from "../src/synth-cuts.js";
import { fetchDailyCloses } from "../src/prices.js";
import type { Indicator } from "../src/domain-types.js";
import { readEnv } from "../src/config.js";

export const REL_TOL = 1e-9;

export interface ParityRow {
  date: string;
  stored: Readonly<Record<string, number>> | null | undefined;
  fresh: Readonly<Record<string, number>> | null | undefined;
}

export interface ParityCounts {
  rows: number;
  compared: number;
  mismatched: number;
  storedNull: number;
  details: string[];
}

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
const close = (a: number, b: number): boolean => Math.abs(a - b) <= REL_TOL * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Pure compare over per-date {stored, fresh} band-cut maps, restricted to `keys` (the id's wire
 * keys — extra stored keys outside them, e.g. F3's `velEvtRed`/`z*`, are out of scope). Per row:
 * fresh-finite + stored-missing ⇒ storedNull; stored-present + fresh-missing, or both present
 * beyond REL_TOL ⇒ mismatched; both missing (R1 unarmed) ⇒ neither. `compared` counts rows with
 * at least one both-sides numeric comparison.
 */
export function compareBandCuts(rows: readonly ParityRow[], keys: readonly string[]): ParityCounts {
  const out: ParityCounts = { rows: rows.length, compared: 0, mismatched: 0, storedNull: 0, details: [] };
  for (const row of rows) {
    let comparedHere = false;
    let mismatchHere = false;
    let nullHere = false;
    for (const key of keys) {
      const s = row.stored?.[key];
      const f = row.fresh?.[key];
      if (finite(f) && !finite(s)) {
        nullHere = true;
        out.details.push(`${row.date} ${key} stored=null fresh=${f}`);
      } else if (finite(s) && !finite(f)) {
        mismatchHere = true;
        out.details.push(`${row.date} ${key} stored=${s} fresh=null`);
      } else if (finite(s) && finite(f)) {
        comparedHere = true;
        if (!close(s, f)) {
          mismatchHere = true;
          out.details.push(`${row.date} ${key} stored=${s} fresh=${f}`);
        }
      }
    }
    if (comparedHere) out.compared++;
    if (mismatchHere) out.mismatched++;
    if (nullHere) out.storedNull++;
  }
  return out;
}

function indicatorById(id: string): Indicator {
  const ind = ALL_INDICATORS.find((i) => i.id === id);
  if (!ind) throw new Error(`[probe-band-cuts-parity] ${id} not in ALL_INDICATORS`);
  return ind;
}

const wireKey = (id: string, level: "amber" | "red"): string => {
  const key = POINT_BAND_CUTS_OF[id]?.find((b) => b.level === level)?.key;
  if (key === undefined) throw new Error(`[probe-band-cuts-parity] no ${level} wire key for ${id}`);
  return key;
};

async function main(): Promise<void> {
  const env = process.argv.includes("--env=prod") ? "prod" : "local";
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 60;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`[probe-band-cuts-parity] bad --limit: ${limitArg}`);
  if (env === "local") process.loadEnvFile(".env.local");
  const { resolveStore } = await import("./backfill/resolve-store.js");
  const store = await resolveStore(env, "ro");
  const appEnv = readEnv();

  let failures = 0;
  let blockErrors = 0;

  const runBlock = async (
    id: string,
    keys: readonly string[],
    freshByDate: () => Promise<ReadonlyMap<string, Readonly<Record<string, number>> | undefined>>,
  ): Promise<void> => {
    try {
      const [stored, fresh] = await Promise.all([store.getSeries(id, limit), freshByDate()]);
      const counts = compareBandCuts(
        stored.map((p) => ({ date: p.date, stored: p.bandCuts, fresh: fresh.get(p.date) })),
        keys,
      );
      failures += counts.mismatched + counts.storedNull;
      for (const d of counts.details) console.log(`  ${id} ${d}`);
      console.log(
        `${id} rows=${counts.rows} compared=${counts.compared} mismatched=${counts.mismatched} storedNull=${counts.storedNull}`,
      );
    } catch (err) {
      blockErrors++;
      console.log(`${id} BLOCK ERROR: ${String(err)}`);
    }
  };

  // CG — the cron's anchored base (`cgPoints`/`cgRows`), fetched to `CG_LEVEL_ANCHOR`.
  await runBlock("CG", [wireKey("CG", "amber"), wireKey("CG", "red")], async () => {
    const lookbackDays = cgLookbackDays(new Date());
    const [hg, gc] = await Promise.all([
      fetchDailyCloses("HG=F", { deep: true, lookbackDays, now: Date.now, env: appEnv }),
      fetchDailyCloses("GC=F", { deep: true, lookbackDays, now: Date.now, env: appEnv }),
    ]);
    const readings = cgRows(indicatorById("CG"), cgPoints(hg, gc));
    return new Map(readings.map((r) => [r.date, r.bandCuts ?? undefined]));
  });

  // R1 / R8 — the cron's smoothed-level branch over the full-history feed.
  for (const id of ["R1", "R8"] as const) {
    const keys =
      id === "R1" ? [POST_INVERSION_BAND.key] : R8_MEAN_CUT_BANDS.map((b) => b.key);
    await runBlock(id, keys, async () => {
      const ind = indicatorById(id);
      const sm = SMOOTHED_LEVEL_OF[id];
      if (!sm) throw new Error(`[probe-band-cuts-parity] ${id} has no SMOOTHED_LEVEL_OF row`);
      const obs = await fetchIndicatorObservations(ind, { fullHistory: true }, new Date().toISOString(), appEnv);
      const readings = smoothedLevelReadingSeries(ind, obs, sm.window, undefined, sm.redWindow);
      return new Map(readings.map((r) => [r.date, r.bandCuts ?? undefined]));
    });
  }

  // F3 — synth expanding-percentile cuts over the store's OWN level history, three wire keys only.
  await runBlock("F3", [wireKey("F3", "amber"), wireKey("F3", "red"), F3_VELOCITY_BAND.key], async () => {
    const ind = indicatorById("F3");
    const hist = await store.getSeries("F3", SYNTH_HISTORY_LIMIT);
    const cuts = synthCutSeries(
      hist.map((p) => p.value),
      priorThresholds(ind),
      ind.velocityWindow ?? SYNTH_VEL_WINDOW,
    );
    return new Map(
      hist.map((p, i) => {
        const entries: Array<[string, number]> = [];
        const put = (key: string, v: number | undefined): void => {
          if (finite(v)) entries.push([key, v]);
        };
        put(wireKey("F3", "amber"), cuts.levelAmber?.[i]);
        put(wireKey("F3", "red"), cuts.levelRed?.[i]);
        put(F3_VELOCITY_BAND.key, cuts.amberVelocity?.[i]);
        return [p.date, entries.length > 0 ? Object.fromEntries(entries) : undefined];
      }),
    );
  });

  const verdict = failures === 0 && blockErrors === 0 ? "PASS" : "FAIL";
  console.log(`VERDICT: ${verdict} (mismatch+storedNull=${failures}, blockErrors=${blockErrors})`);
  if (verdict !== "PASS") process.exitCode = 1;
}

const isDirect = process.argv[1]?.endsWith("probe-band-cuts-parity.ts") === true;
if (isDirect) {
  await main();
}
