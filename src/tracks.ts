/**
 * Off-ladder tracks (slow bubble / VIX bottom / pension drawdown) as DATA.
 *
 * The three tracks share near-identical WIRING — fetch+score, project the verdict
 * into the alert columns, decide a per-tier notify, emit a `[tag] …` console line —
 * even though their MATH is genuinely different (Minsky composite vs. VIX term
 * structure vs. EUR-drawdown blend). This module collapses that wiring into one
 * `OffLadderTrack` record per track + `const TRACKS = […]`, so `runScoringCycle`
 * and `assembleRun` loop over them instead of hand-repeating each three times, and
 * a 4th track becomes one module entry rather than a ~7-file edit (architecture
 * refactor S1).
 *
 * Each track's scorer + helpers moved here VERBATIM from run.ts — the per-track
 * degrade-to-null (≠ CALM) contract and every console/notify string are preserved
 * byte-for-byte. `degrade<T>()` lives here too (the `run-cycle-*.ts`/`run-dbfirst.ts` feeds still import it).
 */

import { feedsOf } from "./feed-ports.js";
import type { Indicator, Observation } from "./domain-types.js";
import { SLOW_INDICATORS, BOTTOM_INDICATORS } from "./registry-price.js";
import { INDICATORS } from "./registry-fred.js";
import { dbFirstOrDirect, deepArmSince, needRowsForSeedDepth, tailSince14, type DbFirstCtx, type DbFirstFeedSpec } from "./series-db-first.js";

/** The slow track's R5/VIXCLS DB-first feed spec (stage 4.2, R4/R7 template) — spread into
 *  `scoreSlowTrack`'s `dbFirstOrDirect` ask; the direct arm tests drive `resolveDbFirstArm` with it. */
export const R5_SLOW_DB_FIRST_FEED: DbFirstFeedSpec = { id: "R5", needRows: needRowsForSeedDepth() };
import type { NtfyMessage } from "./ntfy.js";
import type { AlertRecord, BandField, StoredReading, Store, DegradeEvent, DegradeEffect, CoverageDegrade } from "./store.js";
import {
  scoreSlow,
  computeSlowVerdict,
  slowBackfillRows,
  slowStoredReadings,
  type SlowVerdict,
  type SlowBand,
} from "./slow.js";
import { buildTierNotification } from "./notify_tier.js";
import { SLOW_TIER } from "./slow_tier.js";
import { BOTTOM_TIER } from "./bottom_tier.js";
import { computeBottomVerdict, minBottomObs, type BottomVerdict, type BottomState } from "./bottom.js";
import { alignTermStructure } from "./vix_term.js";
import { priceLegReadingSeries } from "./pension.js";
import { withNewest } from "./scorers-core.js";
import { gapFillFrom } from "./intraday.js";
import { confirmClosesFor } from "./family-table.js";
import type { SeriesById } from "./run-seeds.js";
import type { Env } from "./config.js";
import { isNoFreeSource } from "./no-free-source.js";
import { errMsg } from "./err-msg.js";

/** Group rows into a `SeriesById`, each id's rows in input order. */
function seriesById(rows: readonly StoredReading[]): SeriesById {
  const out = new Map<string, StoredReading[]>();
  for (const r of rows) out.set(r.indicatorId, [...(out.get(r.indicatorId) ?? []), r]);
  return out;
}

/**
 * Run a SECONDARY feed's fetch+score under the §5 pre-mortem policy: a secondary
 * feed must NEVER abort the FRED credit/rate core. On ANY throw, warn with the
 * feed's exact message and return its fallback so the run proceeds without it.
 * `warning` is the per-feed prefix (e.g. "[geo] oil feed unavailable — …"); the
 * caught error is appended as ": <msg>", reproducing the prior per-feed
 * `console.warn` wording byte-for-byte. The fallback shape varies per feed ([] for
 * price/geo/ebp readings, null for the slow track's null-distinct-from-CALM
 * contract) — the generic `T` carries each. Pure policy wrapper; the IO lives in fn.
 */
export async function degrade<T>(warning: string, effect: DegradeEffect, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const reason = errMsg(err);
    console.warn(`${warning}: ${reason}`);
    // Audit rank 6 — persisted degrade trace: record this fallback so a calm-ward band
    // caused by a non-live feed is recoverable from the alert row (Vercel keeps no logs).
    // `warning` is the per-feed scope prefix — e.g. run-cycle-fred.ts's
    // "[baa10y] Baa10y feed unavailable — …" (the bracketed feed tag is the convention; the
    // wording after it belongs to the call site and is NOT pinned here).
    const event: DegradeEvent = { scope: warning, reason, effect };
    if (isNoFreeSource(err)) event.kind = "no-free-source";
    logDegrade(event);
    return fallback;
  }
}

/**
 * Module-level degrade collector (audit rank 6). `degrade()` appends here on every
 * fallback; runScoringCycle resets it at the top of a run and drains it into the
 * alert row's `degraded` column just before recordRun. Module-level (not threaded)
 * because a single scoring cycle is the natural unit and the whole feed graph flows
 * through `degrade()` — no wiring across the ~10 call sites. `runScoringCycle` runs
 * concurrently only in tests; a test that asserts the trace resets first (below).
 */
const degradeLog: DegradeEvent[] = [];
/** Events recorded after `drainDegradeLog` (post-recordRun steps, the seed tail); the EOD post-tail `updateRunTrace` and the intraday slot rewrite (`rewriteIntradayVerdict`) persist them. */
const lateLog: DegradeEvent[] = [];
/** Set by `drainDegradeLog`, cleared by `resetDegradeLog`: an event recorded in between goes to `lateLog`. */
let drained = false;
function logDegrade(event: DegradeEvent): void {
  if (drained) {
    console.warn(`[degrade] post-drain - ${event.scope}: ${event.reason}`);
    lateLog.push(event);
  } else degradeLog.push(event);
}

/** Record a degrade event from a fallback that doesn't flow through `degrade()` —
 *  run-dbfirst.ts's core-FRED per-indicator fallback scores off a lagging stored vintage (or drops
 *  the indicator) without a wrapper; unrecorded it would be invisible post-hoc in the
 *  alert row's `degraded` trace, the exact gap the trace exists to close.
 *
 *  `effect` is required (no default): `"trace"` persists the event without arming the push caveat.
 *  The fourth arg is an OPTIONS OBJECT carrying the event's OPTIONAL structured payload, set by
 *  exactly one caller in run-cycle-dial.ts: `coverage` (the `[coverage]` emitter's per-family non-live
 *  trace), so `/api/lab` can name the holding members without parsing the prose `scope`. An omitted
 *  key is ABSENT from the pushed event, so every other call site persists a byte-identical row.
 *  `kind` tags a no-free-source fallback recorded outside `degrade()`. */
export function recordDegrade(
  scope: string,
  reason: string,
  effect: DegradeEffect,
  extra?: { coverage?: CoverageDegrade; kind?: DegradeEvent["kind"] },
): void {
  const event: DegradeEvent = { scope, reason, effect };
  if (extra?.coverage !== undefined) event.coverage = extra.coverage;
  if (extra?.kind !== undefined) event.kind = extra.kind;
  logDegrade(event);
}

/** Clear the degrade collector — called at the START of each runScoringCycle. */
export function resetDegradeLog(): void {
  degradeLog.length = 0;
  lateLog.length = 0;
  drained = false;
}

/** Take + clear the post-drain events, as `trace`: they ran after this run's push decision, so they never arm this
 *  run's caveat. `late` keeps the recorded effect — a `notify` one surfaces on the NEXT EOD push (`priorLateNotifyEvents`). */
export function drainLateDegrades(): DegradeEvent[] {
  return lateLog.splice(0).map((e) => ({ ...e, effect: "trace", late: e.effect }));
}

/** Take + clear the run's collected degrade events (runScoringCycle, pre-recordRun). */
export function drainDegradeLog(): DegradeEvent[] {
  drained = true;
  return degradeLog.splice(0);
}

/** Snapshot the collected degrade events WITHOUT clearing (audit-extras 1.2) — the push
 *  annotation reads the log mid-run (at assembleRun time), while the full drain for the
 *  persisted `degraded` trace stays at its pre-recordRun site. */
export function peekDegradeLog(): DegradeEvent[] {
  return [...degradeLog];
}

/**
 * Score the slow "bubble-state" tier (Phase 3 Stage 1B). Reuses the price feed's
 * QQQ closes (fetched once per run — no duplicate price call) + VIXCLS (full
 * history for the bottom-decile cut), scores the two 0–2 composite
 * contributors, and rolls them into a SlowVerdict. The slow track is a secondary
 * low-frequency signal, fully isolated from the fast credit/rate core — so ANY feed
 * hiccup must NOT abort the fast verdict (§5 pre-mortem). Degrades to `null` (NOT a
 * CALM verdict) when the price feed is down (empty `qqq`) or VIXCLS fails: a null
 * persists as null slow_score/slow_band, keeping a degraded run distinguishable from
 * a genuine CALM, and the slow tier simply stays silent that run.
 */
async function scoreSlowTrack(qqq: Observation[], runAt: string, env: Env, dbFirst?: DbFirstCtx): Promise<{ v: SlowVerdict; vix: Observation[] } | null> {
  // Empty QQQ ⇒ the price feed degraded this run; the slow track can't score price
  // acceleration without it, so degrade to null (not CALM) too. Logged for parity
  // with the other degrade paths (the price feed logs its own failure separately).
  if (qqq.length === 0) {
    console.warn("[slow] bubble track unavailable - QQQ empty (price feed degraded) - slow verdict null this run");
    return null;
  }
  const { fetchSeries } = feedsOf(dbFirst);
  return degrade<{ v: SlowVerdict; vix: Observation[] } | null>(
    "[slow] bubble track unavailable - slow verdict null this run",
    "notify",
    null,
    async () => {
      // DB-first (stage 4.2, R4/R7 template): stored `R5` VIXCLS closes + a `TAIL_DAYS` tail; a store
      // shallower than the seed depth re-fetches deep (bounded at `deepArmSince`) and persists it under R5, scored by the
      // run's own `seriesScorerFor` (core-loop vintage). Absent dbFirst (dial-less / test) ⇒ the direct
      // arm: the plain fullHistory fetch, persisting nothing (pre-4.2 behaviour).
      const r5 = INDICATORS.find((i) => i.id === "R5");
      if (r5 === undefined) throw new Error("[slow] R5 is not a FRED-loop registry id");
      const scorer = await dbFirst?.seriesScorerFor?.(r5);
      const { points: vix } = await dbFirstOrDirect(scorer === undefined ? undefined : dbFirst, {
        ...R5_SLOW_DB_FIRST_FEED,
        fetchDeep: () => fetchSeries("VIXCLS", { since: deepArmSince(new Date(runAt)), now: new Date(runAt), env }),
        fetchTail: () => fetchSeries("VIXCLS", { since: tailSince14(new Date(runAt)), now: new Date(runAt), env }),
        score: scorer ?? (() => []),
        onPersistError: (err) =>
          recordDegrade("[slow-track-db-first] persist failed - R5 history not written, slow scored", String(err), "notify"),
      });
      const scored = scoreSlow(qqq, vix);
      // T3.2 G-b — thread the real fragile-calm flag (Stage 4 left this 2-arg call
      // verdict-invisible with fragileCalm defaulted false; Stage 5 wires it so the
      // fast verdict can floor OK→WATCH). Band/score/ratio stay derived from components only.
      return { v: computeSlowVerdict(scored.components, scored.observability, scored.fragileCalm, scored.spDistToHigh), vix };
    },
  );
}

/**
 * Score the VIX bottom-signal track (vix-bottom plan Stage 4) — the third, fully
 * isolated off-ladder track. Takes the pre-fetched VIXCLS + VXVCLS legs
 * (via fetchVixTermLegs, threaded through TrackCtx — the pair
 * is now shared with the COINCIDENT VT indicator, no longer double-fetched; feed
 * consolidation 2026-07-05) and folds the date-aligned series through
 * computeBottomVerdict. Like the slow track this is a secondary off-ladder signal: a
 * feed hiccup must NOT abort the fast core (§5). fetchVixSeries already degrades to []
 * on any failure (it swallows its own errors), so there's nothing to throw here —
 * instead an EMPTY leg is the degraded sentinel: degrade to `null` (NOT a CALM verdict)
 * so the run persists bottom_state = null and the bottom tier stays silent, keeping a
 * degraded run distinguishable from a genuine confirmed CALM (mirrors scoreSlowTrack's
 * empty-QQQ guard). Fewer than `minBottomObs()` aligned points (empty leg, zero overlap,
 * thin history) ⇒ null + a degrade event, never computeBottomVerdict's indistinguishable CALM.
 */
function scoreBottomTrack(front: Observation[], back: Observation[]): BottomVerdict | null {
  const fail = (why: string): null => {
    const scope = "[bottom] vix-term track unavailable - bottom verdict null this run";
    console.warn(`${scope}: ${why}`);
    recordDegrade(scope, why, "notify");
    return null;
  };
  if (front.length === 0 || back.length === 0) return fail("a VIX leg is empty (feed degraded)");
  const aligned = alignTermStructure(front, back);
  if (aligned.length === 0) return fail("no overlapping dates between legs");
  if (aligned.length < minBottomObs()) return fail(`aligned history short (${aligned.length} < ${minBottomObs()})`);
  return computeBottomVerdict(aligned);
}

// ---------------------------------------------------------------------------
// The generic track interface — wiring as data.
// ---------------------------------------------------------------------------

/** Context the IO shell passes to each track's `score()` (pension needs the store;
 *  slow needs the run's QQQ closes; bottom needs the shared VIXCLS/VXVCLS legs the run
 *  fetches once via fetchVixTermLegs and threads to both the bottom track AND VT). */
export interface TrackCtx {
  store: Store;
  qqq: Observation[];
  vixFront: Observation[];
  vix3mBack: Observation[];
  /** The run's snapshot clock (ISO) — the slow track's fetch windows measure against it. */
  runAt: string;
  /** The run's env — the slow track's VIXCLS fetch reads its feed config from here. */
  env: Env;
  /** DB-first seam for the slow track's VIXCLS→R5 feed (§4.2); absent ⇒ the direct fullHistory fetch. */
  dbFirst?: DbFirstCtx;
}

/**
 * The disjoint off-ladder column groups, one per track. Narrowed from `Partial<AlertRecord>`
 * so a track may set ONLY its own columns: the fast-verdict fields (`level`/`fin`/`rate`/…)
 * are owned by run-core.ts's alert assembly and must never appear here — `Object.assign(alert, …)` would
 * silently overwrite the verdict. A 4th track adds its own `Pick<…>` member to this union.
 */
type OffLadderAlertFields =
  | Pick<AlertRecord, "slowScore" | "slowBand" | "slowMaxScore">
  | Pick<AlertRecord, "bottomState" | "vix" | "vix3m" | "ratio">;

/**
 * Sealed, uniform output of scoring ONE track for ONE run. Closes over the produced
 * (possibly-null) verdict so the loops in run-cycle-confirmers.ts/assembleRun never touch a
 * verdict-typed value — TRACKS stays a non-generic `OffLadderTrack[]` and the loops
 * stay type-clean. The degrade-to-null contract lives inside each projection:
 * a null verdict ⇒ null alert fields, no push, the "degraded" console line.
 */
export interface ScoredTrack {
  /** AlertRecord band field this track owns — the `getLastBand` notify baseline key. */
  baselineField: BandField;
  /** Pre-computed daily-accrual rows (pension only; [] for slow/bottom). */
  rows: StoredReading[];
  /** Verdict → alert columns (sealed projection; all null when the track degraded). */
  alertFields: OffLadderAlertFields;
  /** Per-id series, newest last: slow's observability legs (newest asOf-stamped) + bottom's raw VIX/VIX3M legs.
   *  `assembleRun` persists each `.at(-1)`; the gap-fill sweep fills the rest. */
  storedSeries(asOf: string): SeriesById;
  /** The price symbols `storedSeries` is built off — each stored id is marked `markFallbackSourced` with them (run-cycle-dial.ts). */
  priceSymbols?: readonly string[];
  /** Own-tier notify decision + payload, decided on the PRIOR run's NON-NULL band. */
  notification(lastBand: string | null, asOf: string): { push: boolean; message: NtfyMessage | null };
  /** The exact `[slow]`/`[bottom]`/`[pension]` transcript line for this run. */
  consoleLine: string;
  /**
   * T3.2 G-b — slow track's "fragile calm" flag (prolonged low-vol), surfaced from
   * the SlowVerdict so the run loop can floor the fast verdict OK→WATCH (the first slow→fast
   * link). Degraded slow (v === null) ⇒ false (no floor — conservative). Slow-only;
   * absent/false on bottom/pension tracks.
   */
  fragileCalm?: boolean;
  /**
   * D-B — the slow track's QQQ distance-to-252d-high fraction (∈(0,1], →1 = at the high),
   * surfaced from the SlowVerdict so run-core.ts can thread it into the divergence escalator
   * (alert-band.ts). Degraded slow (v === null) ⇒ null (no bump). Slow-only; absent on
   * bottom/pension tracks.
   */
  spDistToHigh?: number | null;
}

/**
 * One off-ladder track as data: its indicator metadata (for the /status off-ladder
 * filter + /series labels), the band field it owns, and a `score()` that does the IO
 * (fetch + score) and seals the verdict into the uniform `ScoredTrack` projections.
 */
interface OffLadderTrack {
  baselineField: BandField;
  indicators: Indicator[];
  score(ctx: TrackCtx): Promise<ScoredTrack>;
}

const slowTrack: OffLadderTrack = {
  baselineField: "slowBand",
  indicators: SLOW_INDICATORS,
  async score(ctx: TrackCtx): Promise<ScoredTrack> {
    const slow = await scoreSlowTrack(ctx.qqq, ctx.runAt, ctx.env, ctx.dbFirst);
    const v = slow?.v ?? null;
    return {
      baselineField: "slowBand",
      rows: [],
      priceSymbols: ["QQQ"], // `ctx.qqq` — the price batch's QQQ closes
      // Slow bubble tier (Stage 1B): the composite score + band, or null when the
      // slow feed degraded this run. Isolated — never feeds `verdict`.
      // `slowMaxScore` (OFF-2) rides along so the read path can render `score / max` without
      // re-deriving `activeCount` it cannot see; it degrades to null with the other two.
      alertFields: {
        slowScore: v ? v.score : null,
        slowBand: v ? v.band : null,
        slowMaxScore: v ? v.maxScore : null,
      },
      // Persist the OBSERVABILITY set (complacency split into its two legs), not the
      // scored set — so /api/series serves the continuous per-leg metrics. Falls back
      // to the scored components for any verdict built without observability (hand-
      // built test literals).
      // R5 (standard-gap-fill plan): each leg = `slowBackfillRows` over the gap-fill window + the live row.
      // The live row carries QQQ's NEWEST date, never the run's FRED-driven `asOf` (the bottom track's rule below):
      // it is scored off QQQ through that close, so the run's date either mislabels a lagging input or stamps a
      // newer one as older (Defect 4).
      storedSeries: (asOf: string) => {
        if (!slow) return new Map();
        const live = slowStoredReadings(slow.v.observability ?? slow.v.components, ctx.qqq.at(-1)!.date);
        // The sweep drops each id's first `confirmClosesFor` rows ⇒ start that many QQQ closes before the window.
        const at = ctx.qqq.findIndex((o) => o.date >= gapFillFrom(asOf));
        const head = Math.max(0, ...live.map((r) => confirmClosesFor(r.indicatorId)));
        const cutoff = at < 0 ? gapFillFrom(asOf) : ctx.qqq[Math.max(0, at - head)]!.date;
        const window = seriesById(slowBackfillRows(ctx.qqq, slow.vix, cutoff));
        return new Map(live.map((r) => [r.indicatorId, withNewest(window.get(r.indicatorId) ?? [], r)]));
      },
      notification: (lastBand: string | null, asOf: string) =>
        buildTierNotification(SLOW_TIER, lastBand as SlowBand | null, v, asOf),
      consoleLine: v
        ? `[slow] bubble ${v.band} · score ${v.score}/${v.maxScore} (${v.activeCount} active)`
        : "[slow] bubble track degraded this run - slow verdict null (silent)",
      // T3.2 G-b — surface the fragile-calm flag for the run loop to floor the fast verdict.
      // Degraded slow (v === null) ⇒ false (no floor — conservative).
      fragileCalm: v ? (v.fragileCalm ?? false) : false,
      // D-B — surface the QQQ distance-to-252d-high fraction for the divergence escalator.
      // Degraded slow (v === null) ⇒ null (no bump — conservative).
      spDistToHigh: v ? (v.spDistToHigh ?? null) : null,
    };
  },
};

const bottomTrack: OffLadderTrack = {
  baselineField: "bottomState",
  indicators: BOTTOM_INDICATORS,
  async score(ctx: TrackCtx): Promise<ScoredTrack> {
    const v = scoreBottomTrack(ctx.vixFront, ctx.vix3mBack);
    // The SAME inner-join the verdict scored on (pure, no IO — recomputing is cheaper than
    // threading it out of scoreBottomTrack). Persisting off `aligned` rather than the raw
    // legs is what keeps the row's date identical to `v.asOf`: a raw leg's latest date can
    // be one the join DROPPED, which would re-open the mis-dating this track just fixed.
    const aligned = alignTermStructure(ctx.vixFront, ctx.vix3mBack);
    return {
      baselineField: "bottomState",
      rows: [],
      // VIX bottom-signal tier (Stage 4): the confirmed off-ladder state + the live
      // VIX/VIX3M levels + term-structure ratio, or NULL as a group when its
      // VIXCLS/VXVCLS feed degraded this run. Isolated — never feeds `verdict`.
      alertFields: {
        bottomState: v ? v.state : null,
        vix: v ? v.vix : null,
        vix3m: v ? v.vix3m : null,
        ratio: v ? v.ratio : null,
      },
      // Persist the two raw VIX legs each run (Bug 4) so /api/series can chart their
      // detail charts — reusing priceLegReadingSeries, the SAME builder backfillBottom
      // uses, so the live tail and the seeded history can't drift. A degraded run
      // (v === null) writes no rows, mirroring the pension tail-failed path.
      //
      // The builder is handed the FULL aligned history (`assembleRun` persists its `.at(-1)`,
      // the gap-fill sweep the rest) — NOT a one-element array. A
      // one-element array can never reach priceLegReadingSeries' `i >= 20` branch, so
      // every live-written date carried `delta20: 0` forever, and `backfillBottom` skips
      // any date the live path already wrote (`scripts/backfill.ts:255`) so the zero was
      // permanent and unrepairable — the exact drift this comment claims cannot happen.
      //
      // The rows carry `v.asOf` — the LATEST ALIGNED FEED DATE — never the run's own
      // as-of. The run's `asOf` is FRED-driven (`assembleRun`, run-core.ts); the VIXCLS/VXVCLS legs lag
      // it routinely (weekends, holidays, ~1-business-day posting lag).
      // Stamping the run's date onto a point the feed dated earlier persisted a LAGGING
      // value under a date it never belonged to, silently and with no degrade entry:
      // prod `readings` for obs_date 2026-07-17 carried VIX 15.029999732971191 /
      // VIX3M 18.56999969482422 across three runs — bit-for-bit the feed's 2026-07-10
      // close (confirmed by replaying fetchVixSeries 2026-07-19). Truthful dating is
      // the fix; the leg is NOT dropped on a lag, because `v.asOf !== asOf` is the
      // NORMAL weekend/holiday case and dropping on it would over-fire constantly.
      storedSeries: () =>
        v
          ? new Map([
              ["VIX", priceLegReadingSeries("VIX", aligned.map((p) => ({ date: p.date, value: p.vix })))],
              ["VIX3M", priceLegReadingSeries("VIX3M", aligned.map((p) => ({ date: p.date, value: p.vix3m })))],
            ])
          : new Map(),
      notification: (lastBand: string | null, asOf: string) =>
        buildTierNotification(BOTTOM_TIER, lastBand as BottomState | null, v, asOf),
      consoleLine: v
        ? `[bottom] vix-term ${v.state} · VIX ${v.vix.toFixed(1)} · VIX3M ${v.vix3m.toFixed(1)} · ratio ${v.ratio.toFixed(2)}`
        : "[bottom] vix-term track degraded this run - bottom verdict null (silent)",
    };
  },
};

/**
 * The off-ladder tracks, in console + push order (slow → bottom — the order
 * run.ts printed/pushed them before S1). `runScoringCycle` loops this for scoring +
 * baseline reads + per-track push; `assembleRun` folds the projections. (`api/status.ts` no longer
 * derives a filter from `t.indicators` — track readings are SERVED since 2026-07-22; it drops only the
 * `INTERNAL_SERIES_PREFIXES` rows.)
 */
export const TRACKS: OffLadderTrack[] = [slowTrack, bottomTrack];
