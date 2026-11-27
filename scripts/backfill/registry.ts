/**
 * The canonical backfill job registry (design §4, plan Phase 2).
 *
 * Each entry binds an existing pure orchestration fn to its `liveDeps` and
 * normalizes the result into `{ summary }` (or a throw the runner turns into a
 * non-zero exit). Adding a new backfill = one entry here, nothing else.
 *
 * NOTE: importing `../backfill.js` / `../backfill-slow.js` must NOT trigger their
 * side effects — Phase 4 removes their `invokedDirectly` shims, and even before
 * that those blocks only fire on direct exec, not import.
 */
import {
  backfillAll,
  backfillBottom,
  backfillCape,
  backfillDownsideBreaks,
  backfillFxhCmp,
  backfillFxhCmpDeep,
  backfillInputSeries,
  backfillLegs,
  backfillPension,
  liveFxhCmpDeps,
  liveInputSeriesDeps,
  liveBottomDeps,
  liveCapeDeps,
  liveDeps,
  liveLegsDeps,
  livePensionDeps,
} from "../backfill.js";
import { backfillSlow, liveSlowDeps } from "../backfill-slow.js";
import { backfillLegPillars, liveLegPillarDeps } from "./backfill-leg-pillars.js";
import type { Store } from "../../src/store.js";

/** Per-run options the CLI threads into a job. Every job takes it; most ignore every field. */
export interface JobOpts {
  /** `--restate=<id,…>`: re-score + re-write these ids' FULL stored history (cut-retune propagation).
   *  Only jobs with `supportsRestate` accept it — the runner rejects it for the rest. */
  restate?: readonly string[];
  /** `--reshadow-all=<id,…>`: re-write these raw-close ids' FULL stored history under a fresh vintage
   *  (feed-provenance re-seed — e.g. LEGP_* chain rebase, DEXUSEU→the closes provider). Only jobs with
   *  `supportsReshadowAll` accept it — the runner rejects it for the rest. */
  reshadowAll?: readonly string[];
  /** `--closes=<n>`: how many stored closes a replay-style pass walks. Only jobs with
   *  `supportsCloses` accept it — the runner rejects it for the rest. */
  closes?: number;
  /** `--dry-run`: set so a pass whose write the dry-run Store wrapper cannot tally
   *  (`putLegPillars`) can stop BEFORE it, rather than throwing on an unclassified method. */
  dryRun?: boolean;
  /** `--deepen[=<id,…>]`: force `full` for these ids (or every spec when `"all"`) to re-deepen a frozen left edge;
   *  named ids also narrow the pass to deepen ∪ restate. Only `supportsDeepen` jobs accept it (runner rejects the rest). */
  deepen?: readonly string[] | "all";
}

export interface BackfillJob {
  name: string;        // CLI token + Action choice value; MUST NOT be "all" (reserved selector)
  description: string;
  /** Set when the job's pass can rebuild history under changed CUTS (`--restate`). Absent ⇒ the
   *  runner errors on `--restate` for this job, rather than accepting a flag it would drop. */
  supportsRestate?: boolean;
  /** Set when the job's raw-close pass can re-write every projected row under a fresh vintage
   *  (`--reshadow-all`). Absent ⇒ the runner errors on `--reshadow-all` for this job. NEVER set on
   *  `indicators` (its full re-shadow would write the unresolved 8.7k state flips — Stage 0 gate). */
  supportsReshadowAll?: boolean;
  /** Set when the job replays a bounded window of stored closes and can size it (`--closes`).
   *  Absent ⇒ the runner errors on `--closes` for this job, rather than accepting a flag it
   *  would drop (the operator would read the exit-0 as "the deep window was seeded"). */
  supportsCloses?: boolean;
  /** Set when the job re-deepens a frozen left edge (`--deepen`). Only `indicators` drives
   *  `backfillAll`, so it alone carries this; the runner errors on `--deepen` for the rest. */
  supportsDeepen?: boolean;
  /** `ids` = indicator ids the pass wrote — the runner self-prunes shadowed vintages for exactly these.
   *  `failures` = per-item failures the pass SURVIVED. Returning them (rather than throwing) is what lets
   *  the runner prune the ids that DID write before it exits 1 — a throw here strands the written vintage
   *  behind the old one (2026-08-16: a sovereign-spread restate wrote 3351 rows that prod never served). */
  run(store: Store, opts?: JobOpts): Promise<{ summary: string; ids: string[]; failures?: string[] }>;
}

/**
 * The ids that ACTUALLY seeded rows — the exact prune scope. A pass reports a count per id
 * including 0 for "already complete"; handing those zeros to `pruneShadowedReadings` would
 * prune across every id a no-op pass merely looked at (~25 for `indicators`), deleting
 * vintages the pass never shadowed.
 */
export function seededIds(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([id]) => id);
}

/** The live pass functions + their deps; `makeRegistry` takes a fake of this for offline tests. */
export const livePasses = {
  backfillAll, backfillBottom, backfillCape, backfillDownsideBreaks, backfillFxhCmp, backfillFxhCmpDeep,
  backfillInputSeries, backfillLegs, backfillPension, backfillSlow, backfillLegPillars,
  liveDeps, liveBottomDeps, liveCapeDeps, liveFxhCmpDeps, liveInputSeriesDeps, liveLegsDeps, livePensionDeps,
  liveSlowDeps, liveLegPillarDeps,
};
export type BackfillPasses = typeof livePasses;

export function makeRegistry(passes: BackfillPasses = livePasses): BackfillJob[] {
  return [
    {
      name: "indicators",
      description: "All FRED/price/EBP indicator confirmed-state history (insert-missing).",
      // Like `dbreak`, its stored column is a CUT-dependent confirmed state, so a cut or
      // scoring-seam change strands the old rows. `--restate=F3,F9,F11` re-scores + re-writes the
      // named ids' FULL history (E8 item 1: backfill used to score `synthPriors` ids against their
      // registry degrade fallback). This is NOT `--reshadow-all` — the Stage 0 gate below stands.
      supportsRestate: true,
      supportsDeepen: true,
      async run(store, opts) {
        // `--deepen=<ids>` narrows the PASS to those ids (+ any `--restate` ids): a one-id head-repair must
        // not re-shadow/prune the other ~46. Bare `--deepen` (`"all"`) keeps the full pass.
        // `--restate=<ids>` ALONE narrows the pass to the restated ids too (2026-09-24): ship.sh's
        // auto-restate of two sovereign-spread ids ran all 40 specs and died on a price-feed hourly cap over 14
        // unrelated price ids — the restate had already been written, the stamp never ran, and
        // the release aborted. A restate must not be able to fail on an id it never touched.
        const deepenIds = Array.isArray(opts?.deepen) ? (opts.deepen as readonly string[]) : undefined;
        const restateIds = opts?.restate ?? [];
        const only =
          deepenIds !== undefined ? [...deepenIds, ...restateIds]
          : opts?.deepen === undefined && restateIds.length > 0 ? [...restateIds]
          : undefined;
        const { total, seeded, failures } = await passes.backfillAll(store, passes.liveDeps, { restate: opts?.restate, deepen: opts?.deepen, only });
        const failed = failures.map((f) => f.id);
        const suffix = failed.length > 0 ? `; ${failed.length} FAILED: ${failed.join(", ")}` : "";
        return {
          summary: `${total} row(s) across ${Object.keys(seeded).length} indicator(s)${suffix}`,
          ids: seededIds(seeded),
          failures: failed,
        };
      },
    },
    {
      name: "slow",
      description: "Slow-tier continuous metric history (vintage-shadow).",
      async run(store) {
        const { inserted, dates, runAt, ids } = await passes.backfillSlow(store, passes.liveSlowDeps);
        return { summary: `${inserted} row(s) across ${dates} date(s) at vintage ${runAt}`, ids };
      },
    },
    {
      name: "pension",
      description: "PENSION-registry price legs (every price-feed INPUT_SERIES row in the PENSION registry; FX leg DEXUSEU via the closes provider) raw stored series (insert-missing). FRED-fed PENSION rows are seeded by `inputs`.",
      supportsReshadowAll: true,
      async run(store, opts) {
        const { inserted, perLeg } = await passes.backfillPension(store, passes.livePensionDeps, { reshadowAll: opts?.reshadowAll });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      name: "bottom",
      description: "VIX-bottom legs (VIXCLS/VXVCLS) raw stored series (insert-missing).",
      supportsReshadowAll: true,
      async run(store, opts) {
        const { inserted, perLeg } = await passes.backfillBottom(store, passes.liveBottomDeps, { reshadowAll: opts?.reshadowAll });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      name: "cape",
      description: "CAPE valuation leg (F7) raw stored series, FULL 1871→now history (insert-missing).",
      supportsReshadowAll: true,
      async run(store, opts) {
        const { inserted, perLeg } = await passes.backfillCape(store, passes.liveCapeDeps, { reshadowAll: opts?.reshadowAll });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      // The downside-break detectors' COMPUTED confirmed-state series (every DOWNSIDE_DETECTORS
      // row: DB_SMH, DB_XLK) — insert-missing and additive (via backfillHistory's scored seam),
      // so it belongs in `all` AND `safe` (only `slow`'s vintage-shadow pass is destructive-gated).
      // Fills the DB_* detail graphs (api/series.ts `downsideSeries`), previously cron-seeded only.
      name: "dbreak",
      description:
        "Downside-break detectors (DB_SMH, DB_XLK) + EW rel-strength legs (RS_SMH, RS_XLK) computed confirmed-state series (insert-missing).",
      // The only job whose stored column is a CUT-dependent confirmed state, so it is the only one
      // a cut retune can strand — see backfillDownsideBreaks's ⚠ RESTATE note.
      supportsRestate: true,
      async run(store, opts) {
        // Same scoping as `indicators`: a `--restate=<ids>` pass runs only those legs, so an unrelated
        // leg's feed failure cannot fail (or re-shadow/prune around) a restate that already wrote.
        const restateIds = opts?.restate ?? [];
        const only = restateIds.length > 0 ? [...restateIds] : undefined;
        const { inserted, perLeg } = await passes.backfillDownsideBreaks(store, passes.livePensionDeps, { restate: opts?.restate, only });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      // Insert-missing and additive like pension/bottom/cape, so it belongs in `all`
      // (only `slow`'s vintage-shadow pass is destructive-gated).
      name: "legs",
      description: "Per-leg EUR closes (LEGP_*) for the nine ladder legs (insert-missing).",
      supportsReshadowAll: true,
      async run(store, opts) {
        const { inserted, perLeg } = await passes.backfillLegs(store, passes.liveLegsDeps, { reshadowAll: opts?.reshadowAll });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      // Insert-missing and additive like pension/bottom/cape. Its fetch is HARD-CAPPED at
      // FXH_CMP_LOOKBACK_DAYS even under --reshadow-all (free-tier price-feed guard).
      name: "fxhcmp",
      description: "FXH haven-leg component closes (CMP_FXH_*) raw stored series, 3y cap (insert-missing).",
      supportsReshadowAll: true,
      async run(store, opts) {
        const { inserted, perLeg } = await passes.backfillFxhCmp(store, passes.liveFxhCmpDeps, { reshadowAll: opts?.reshadowAll });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      // Insert-missing and additive like pension/bottom/cape. Load-tolerance P1.1: the read
      // handlers' upstream input series (src/input-series.ts), full-depth (no BACKFILL_YEARS trim).
      name: "inputs",
      description: "Read-handler input series (R7/ECY/credit-bridge legs + replay companions) raw stored series, full depth (insert-missing).",
      supportsReshadowAll: true,
      async run(store, opts) {
        const { inserted, perLeg } = await passes.backfillInputSeries(store, passes.liveInputSeriesDeps, { reshadowAll: opts?.reshadowAll });
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      // One-shot DEEP (20y) seed of CMP_FXH_* via backfillHistory. Held out of all/safe
      // (BY_NAME_ONLY_JOBS): USER-owned, and a 20y pull hits a free-tier price-feed cap. Insert-missing.
      name: "fxhcmpdeep",
      description: "FXH haven-leg component closes (CMP_FXH_*) DEEP 20y seed via backfillHistory (insert-missing).",
      async run(store) {
        const { inserted, perLeg } = await passes.backfillFxhCmpDeep(store, passes.liveFxhCmpDeps);
        const detail = Object.entries(perLeg)
          .map(([id, n]) => `${id}:${n}`)
          .join(", ");
        return { summary: `${inserted} row(s) (${detail})`, ids: seededIds(perLeg) };
      },
    },
    {
      // Replays the danger engine over the last `--closes` stored closes and persists every
      // (date × leg × super-group) pillar into `leg_pillars`. Insert-missing (upsert with
      // `ignoreDuplicates` on the 4-col PK), so it is not destructive. It was HELD OUT of the
      // `all`/`safe` selectors until prod had the table; W4 Stage 4.5 FLIPPED that, so it now runs
      // in BOTH selectors — the default prod seed (`safe --env=prod`) includes it. Consequence:
      // the default prod seed now carries a `--closes`-deep engine replay plus a ~16k-row upsert,
      // and this job THROWS if an EARLY-WARN (sleeve, super_group) pair comes back under 500 rows
      // (`backfill-leg-pillars.ts`) — a prod data shortfall exits the default seed non-zero rather
      // than silently seeding a permanently-warm-up column. It is ordered last in `safe`, so
      // nothing else is skipped when it fires.
      //
      // REGENERATION AFTER A VINTAGE CHANGE (W4 Stage 4.4). The spec names
      // `--reshadow-all` as the regen mechanism; this job deliberately does NOT declare
      // `restatableIds`, and it does not need to. `generator` is part of the 4-col PK, so a
      // new vintage's rows simply DO NOT EXIST and the ordinary insert-missing pass writes
      // the whole history under the new hash, leaving every old-vintage row intact
      // (dev-DB history is irreplaceable; nothing in W4 deletes). The regen command is
      // therefore the plain one — `npm run backfill -- legpillars --closes=<n>` — and
      // wiring `--reshadow-all` here would add a destructive-confirm prompt in front of a
      // non-destructive write.
      name: "legpillars",
      description:
        "Per-leg super-group pillar history (leg_pillars) — LOCAL replay of stored closes, no provider fetch (insert-missing).",
      supportsCloses: true,
      async run(store, opts) {
        return passes.backfillLegPillars(store, passes.liveLegPillarDeps, { closes: opts?.closes, dryRun: opts?.dryRun });
      },
    },
  ];
}

export const REGISTRY: BackfillJob[] = makeRegistry();

/** Lookup by name; `undefined` for an unknown name (backfill/run.ts turns that into a usage error). */
export function findJob(name: string): BackfillJob | undefined {
  return REGISTRY.find((j) => j.name === name);
}
