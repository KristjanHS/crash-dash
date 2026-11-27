/**
 * Scorer engine + generic scorers (Stage 5b.1 split — internal-graph LEAF of the
 * `scorers-*.ts` split): the ONE per-day assembly loop (`buildReadings`), the shared
 * velocity/level series builder (`ratioReadingSeries` + `SeriesSpec`), the
 * min-observation guard (`latest`), the FRED level+velocity layer
 * (`indicatorReadingSeries`/`indicatorLegSeries`/`scoreIndicator`), the
 * derived-variable machinery (G1 oil + the generic `derivedReadingSeries`), and the
 * date-join primitives (`alignByDate`/`alignByDates`), plus the reading-layer freshness
 * stamp (`stampFreshness`). Pure, no IO. Imports domain/threshold-config/family-descriptor/
 * `family-table.ts` and `ladder.ts` (the shipped cadence→lag rule, imported rather than
 * duplicated) ONLY — never the registry, and since CORE-9 Stage E (2026-08-01) never
 * `families.ts` either: `confirmClosesFor` now comes from the zero-value-import leaf
 * `family-table.ts`, which is what severed the old `registry → scorers → families` cycle. The DAG:
 * registry → scorers → scorers-core → {domain, family-table} (ladder is a sibling leaf whose own
 * imports are notify_tier + domain, so it closes no cycle; `import-cycle.test.ts` enforces).
 */

import { resolveBands, type ThresholdConfig } from "./threshold-config.js";
import {
  type DerivedKind,
  type DerivedView,
  type DrawdownLeg,
  type Indicator,
  type Observation,
  type PostInversionCooldown,
  type Reading,
  type State,
  VELOCITY_WINDOW,
  CONFIRM_CLOSES,
} from "./domain-types.js";
import { at } from "./series-math.js";
import {
  asymConfirmedStateSeries,
  scoredDaySeries,
  winningLegSeries,
  velocityDeltaAt,
  type ProxyLegSeries,
} from "./domain-fold.js";
import {
  calibratedZ,
  usesOwnSeriesZ,
  type CalibrationCuts,
} from "./domain-cuts.js";
import { type GeoHybridDescriptor } from "./family-descriptor-core.js";
import { GEO_HYBRID_DESCRIPTOR_OF, POST_INVERSION_BAND, R8_MEAN_CUT_BANDS } from "./family-descriptor-rows.js";
// The ONE shipped freshness rule (cadence → threshold). Imported, never re-implemented,
// so the reading-layer stamp and the notify seam's `verdictHoldLegs` share a single source.
import { assessIndicatorFreshness, lagCutFor, type Freshness } from "./ladder.js";
import { type FeedCalendarToday } from "./dates.js";
// The publication-calendar kernel — a registry-free, clock-free leaf, so importing it here closes
// no cycle (`src/import-cycle.test.ts` enforces). `containmentGrid` is PURE over already-fetched
// observation dates: it issues no query and touches no store, which is what lets the run-path stamp
// derive its own calendars from the rows it was already handed
// (RULED 2026-09-09).
import {
  LAG_SCAN_LIMIT,
  containmentGrid,
  slotAge,
  type FeedObservations,
  type PublicationCalendar,
} from "./publication-calendar.js";
import { confirmClosesFor } from "./family-table.js";
import { slotLag } from "./release-delay.js";
// Registry-free leaf (closure tables only): the slot days a feed could not have gained a print on.
import { isSlotExcused } from "./market-closures.js";

/**
 * The ONE per-day assembly loop, shared by every scorer (Stage-2 refactor). Turns
 * a raw-state series into the `Reading[]` series (oldest→newest) the live commit
 * reading and the backfill both consume — one definition so the latest reading and
 * the persisted history can't drift. `rawStates[k]` aligns to `values[k+baseOffset]`
 * / `dates[k+baseOffset]` (each scorer's window start); `delta20` is `velocityDeltaAt` over the
 * headline `values`. When `confirm` (the
 * default) the per-day `state` folds through the DIRECTIONAL indicator buffer
 * (`asymConfirmedStateSeries` at `confirmClosesFor` — 2026-08-26 ruling: a worse raw
 * state confirms same-day, an improved one stands down after the tier's clean
 * closes). The NVDA gate still passes `confirm: false` (raw, unfolded). The minObs/
 * minLen guards in the scorers keep CONFIRM_CLOSES as a conservative history-length
 * bound — deliberately NOT tier-loosened. Guard-light (returns a short series rather than throwing) — the
 * scalar scoreX wrappers keep the min-observation guard via `latest`.
 */
export function buildReadings(
  indicator: Indicator,
  values: number[],
  dates: string[],
  rawStates: State[],
  baseOffset: number,
  confirm = true,
  decisions?: (number | null)[],
  legs?: Array<string | undefined>,
  rawLegs?: Array<string | undefined>,
): Reading[] {
  if (rawStates.length === 0) return [];
  const states = confirm ? asymConfirmedStateSeries(rawStates, confirmClosesFor(indicator.id)) : rawStates;
  const readings: Reading[] = [];
  for (let k = 0; k < rawStates.length; k++) {
    const i = k + baseOffset;
    readings.push({
      indicator,
      date: at(dates, i),
      level: at(values, i),
      // The SAME `velocityDeltaAt` the fold scores (clamped at `values[0]`), so the card, the alert
      // body and the state read one number — never NaN, which readings.delta20 NOT NULL rejects.
      delta20: velocityDeltaAt(values, i, indicator),
      rawState: at(rawStates, k),
      state: at(states, k),
      // `decisions` (index-aligned to rawStates, NOT to values/dates) is the escape hatch for a
      // COMPOSITE scorer whose decision variable is irreducible to a single-series `derived`
      // transform — DISP's 20d basket return, the conditional gate beside its meanCorr `level`
      // (GT sets the precedent in exposure.ts: the persisted decision IS the maSpread). When
      // omitted, this is byte-identical to the `decisionAt` path every other scorer takes.
      decision: decisions ? (decisions[k] ?? null) : decisionAt(indicator.derived, values, i),
      // `legs` (index-aligned to rawStates, NOT to values/dates — same contract as
      // `decisions` above) carries the per-day winning OR-leg from the caller's ONE
      // scoring fold. Omitted ⇒ `leg` stays undefined; nothing recomputes it here, and
      // it is never persisted (in-memory only — see `Reading.leg` in domain-types.ts).
      leg: legs?.[k],
      // Same index contract as `legs`, but UNGATED by raw-vs-confirmed agreement — populated
      // on exactly the boundary days `leg` blanks. Omitted ⇒ `rawLeg` stays undefined;
      // in-memory only (see `Reading.rawLeg` in domain-types.ts).
      rawLeg: rawLegs?.[k],
    });
  }
  return readings;
}

/**
 * The finite band-cut record for `Reading.bandCuts` (Stage 2.2) — the bespoke scorers' per-day
 * expanding cut, keyed by its WIRE key so `api/series.ts` reads it back verbatim. Drops a null/
 * undefined/NaN leg (a warm-up/unarmed gap), returning `undefined` when none remains, so a stamped
 * cut is only ever a finite value the scorer classified this row against — never a fabricated 0.
 * The value is THREADED from the classify loop, never re-derived here.
 */
export function finiteBandCuts(
  entries: ReadonlyArray<readonly [string, number | null | undefined]>,
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [k, v] of entries) if (v != null && Number.isFinite(v)) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The per-target PUBLICATION CALENDARS a run's freshness stamp scores against — pass 1 of
 * {@link stampFreshness}'s two-pass shape (slice 3, RULED `[USER]` 2026-09-09).
 *
 * Derived ENTIRELY from the observation dates the caller was already handed: every `daily`-cadence
 * id in `readings` becomes a containment CANDIDATE, and each target's grid is
 * `containmentGrid(target, candidates)` over the last {@link LAG_SCAN_LIMIT} of its own dates. No
 * query, no store round-trip, no clock — `containmentGrid` is pure over already-fetched dates, which
 * is the whole reason this can live at the reading layer at all.
 *
 * ⚠ THE GRID SOURCE IS `feedDates`, NOT `r.date` (slice 3 round-2 RULED `[USER]`). A run builds ONE
 * `Reading` per feed, so `r.date` alone is a single date per feed — a ~3-date pool that saturates
 * slot age (a feed dark six sessions would read 2). `run-cycle-*.ts` therefore record each feed's
 * FULL fetched observation grid into a `feedDates` map and pass it here; when an id has an entry
 * there, that history is its authoritative grid and `r.date` is NOT folded in. The map is omitted
 * by fixtures and probes whose array IS the population (one `Reading` per publication day already),
 * and only then does each id's grid fall back to the `r.date`s its readings sit on.
 *
 * ⚠ A TARGET WITHOUT A GRID GETS `null`, AND `null` MEANS "NOT ASSESSED" — never "fresh".
 * `containmentGrid` THROWS below {@link MIN_CALENDAR_SOURCES} independent sources or on an empty
 * target (publication-calendar.ts §12 R2): a feed with too few peers cannot tell its own silence
 * from a holiday. The throw is caught here and reported as an ABSENCE, because the two alternatives
 * are both defects: falling back to the target's own dates would make every slot age 0 and read a
 * frozen feed as fresh forever, and falling back to CALENDAR days would score a day count against a
 * slot cut ({@link LAG_THRESHOLDS}`.daily` is 1 since slice 3), flagging every healthy feed. The
 * whole-run heartbeat (`assessFreshness`, run-core.ts) stays the backstop for both.
 *
 * ⚠ BUILD IT ONCE OVER THE WHOLE RUN'S READINGS. The candidate pool is only as wide as the
 * `readings` handed in, so calling this per scorer would hand a one-indicator pool to
 * `containmentGrid` and drop every target below the source floor. `run-cycle-dial.ts` builds ONE of these
 * over every reading the run produced (and passes the run-wide `feedDates` grid source) and threads
 * it into each {@link stampFreshness} call; the convenience default below (no `feedDates`) is for
 * fixtures and for callers whose array IS the whole population.
 *
 * `compositeLegIds` marks the ids that share a parent's fetch (`COMPOSITE_COMPONENTS`) so they do
 * not count toward the source floor — INJECTED, because deriving it needs the registry and this
 * file must never import it (`registry → scorers → scorers-core` would close a cycle). Omitted ⇒
 * every id counts as independent, which can only ever ADMIT a grid, never suppress one.
 */
export interface LagCalendars {
  /** The target's publication grid, or `null` when one cannot be built (see the ⚠ above). Memoised. */
  readonly gridFor: (id: string) => PublicationCalendar | null;
}

export function lagCalendarsFrom(
  readings: readonly Reading[],
  compositeLegIds: ReadonlySet<string> = new Set<string>(),
  feedDates: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>(),
): LagCalendars {
  const datesById = new Map<string, Set<string>>();
  const cadenceById = new Map<string, string>();
  for (const r of readings) {
    const id = r.indicator.id;
    cadenceById.set(id, r.indicator.cadence ?? "daily");
    let seen = datesById.get(id);
    if (seen === undefined) {
      seen = new Set<string>();
      datesById.set(id, seen);
      // The run passes each feed's FULL fetched history here; that is the authoritative grid.
      const collected = feedDates.get(id);
      if (collected !== undefined) for (const d of collected) seen.add(d);
    }
    // Fall back to the reading's own date ONLY where no history was collected for this id
    // (fixtures/probes call without a `feedDates` map): a collected grid, when present, must not
    // have a single latest `r.date` folded into it — that is the degeneracy slice 3 removed.
    if (!feedDates.has(id)) seen.add(r.date);
  }
  // A CARRIED member is ABSENT from `readings` by definition — its live fetch came back empty/dark,
  // so it produced no reading — yet the run's collector still recorded its stored-fallback close
  // (run-cycle-fred.ts FRED loop). Fold those feed-only ids into the pool as gridable TARGETS, or the
  // dial's absent-member carry gate can never resolve a slot age for them: `gridFor` would throw on
  // an empty target → `null` → "unjudgeable" → the member wrongly stays absent instead of carried,
  // even with a fresh in-cut close (slice-3 regression, `run.wiring.dial.test.ts` carried-member test).
  // They join as targets ONLY — cadence and candidacy stay sourced from real readings, since a dark
  // feed carries no publication date its live daily peers do not already contribute to the pool.
  for (const [id, dates] of feedDates) {
    if (datesById.has(id)) continue;
    const seen = new Set<string>(dates);
    datesById.set(id, seen);
  }
  // The newest `LAG_SCAN_LIMIT` observations — the ONE depth constant, shared with `feed-lag.ts`'s
  // deep read through the `publication-calendar.ts` leaf (do
  // not mint a second).
  const feedOf = (id: string): FeedObservations => ({
    id,
    dates: [...(datesById.get(id) ?? [])].sort().slice(-LAG_SCAN_LIMIT),
    independent: !compositeLegIds.has(id),
  });
  const candidates: FeedObservations[] = [];
  for (const [id, cadence] of cadenceById) if (cadence === "daily") candidates.push(feedOf(id));
  const cache = new Map<string, PublicationCalendar | null>();
  return {
    gridFor: (id: string): PublicationCalendar | null => {
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      let grid: PublicationCalendar | null;
      try {
        grid = containmentGrid(feedOf(id), candidates);
      } catch {
        grid = null; // an absence to REPORT (⚠ above), never a grid coalesced to 0
      }
      cache.set(id, grid);
      return grid;
    },
  };
}

/**
 * FEED-FRESHNESS STAMP at the reading layer (OQ-5 Stage 5.1 — the computation half of
 * S-4, whose enforcement half
 * — `verdictHoldLegs` → the notify seam — already shipped). Returns copies of `readings` with
 * `ageDays` + `lag` + `unit` set from the indicator's OWN cadence — or its own `lagAfterDays`
 * override (E7) where it carries one, resolved by the shared `lagCutFor`.
 *
 * ⚠ SINCE SLICE 3 (2026-09-09) THIS IS THE RUN PATH'S ONLY FRESHNESS COMPUTATION. `verdictHoldLegs`
 * (alert-band.ts) and the absent-member carry gate (dial-assembly.ts) READ the stamp; neither
 * computes one. That is the point of the shape (RULED `[USER]`): with ONE site computing and the
 * rest reading, the run/read unit divergence slice 3 exists to close cannot re-open by construction,
 * where three independently-converted sites could drift again. A SECOND `assessIndicatorFreshness`
 * call on the run path is the defect this slice forbids — `src/run-path-freshness-callers.test.ts`
 * greps the tree and reds on one.
 *
 * TWO-PASS, two units:
 *  - *pass 1* — {@link lagCalendarsFrom} derives each daily/weekly target's publication grid from the
 *    observation dates already in hand (or `calendars`, when the caller built one over a wider
 *    population — `run-cycle-dial.ts` does, and every run-path caller should).
 *  - *pass 2* — `daily`/`weekly` are scored in PUBLICATION SLOTS (`slotAge`) against the id's
 *    resolved `lagCutFor`, stamped `unit: "slots"`. `monthly`/`quarterly` keep CALENDAR days through
 *    the unchanged `assessIndicatorFreshness`, stamped `unit: "days"` — a daily grid has no opinion
 *    about when a monthly feed is due.
 *
 * ONE implementation, by delegation: no threshold is re-declared here. Both arms resolve through
 * `lagCutFor` (ladder.ts + `LAG_THRESHOLDS`), the single lag-resolution point, so the stamp cannot
 * disagree with the read path's `freshnessFrom`; if the cuts move, both move together.
 *
 * ⚠ A DAILY/WEEKLY TARGET WITH NO GRID IS LEFT UNSTAMPED — both fields undefined, i.e. "not
 * assessed", never "fresh" (see {@link lagCalendarsFrom}'s ⚠ for why neither fallback is admissible).
 * Downstream consumers already branch on undefined (`someDailyFeedFresh`, `verdictHoldLegs`), so
 * this fails toward NOT arming, and the whole-run calendar-day heartbeat still backstops it.
 *
 * WHY A SEPARATE SEAM AND NOT INSIDE `buildReadings`: lag is a fact about the
 * *evaluation clock*, and `buildReadings` has none — nor does any of its ~20 scorer
 * callers, which see only fetched observations. Defaulting the clock to the series' own
 * newest date would stamp every frozen feed `0d`/fresh, i.e. substitute a value for an
 * absence on the danger path — the same defect class as the `?? "calm"` this wave exists
 * to remove. So the clock is injected where one exists (the run seam,
 * run-cycle-dial.ts) and readings built without one keep BOTH fields undefined = "not
 * assessed", never "fresh" (see `Reading.ageDays` in domain-types.ts).
 *
 * PURITY IS UNCHANGED: no clock and no module-level cache enters this function. The calendars are
 * derived inside it from its own inputs and `today` is still injected, so the injected-`today` tests
 * still bind.
 *
 * IN-MEMORY ONLY — `readingRow` (store.ts) maps column-by-column via `READINGS_COLS`, so
 * neither field reaches the DB and no migration is owed.
 *
 * `today` IS PER FEED: a {@link FeedCalendarToday} resolver is asked for each reading's OWN
 * `feedTimeZone` (the run path passes `feedCalendarTodayResolver(runAt)`), so a `Europe/*` feed is
 * judged on its publisher's calendar exactly as `/api/status` judges it — never the UTC date. A
 * bare string is one date for every feed, the injected-`today` form the fixtures keep.
 */
export function stampFreshness<T extends Reading>(
  readings: readonly T[],
  today: string | FeedCalendarToday,
  calendars: LagCalendars = lagCalendarsFrom(readings),
): T[] {
  return readings.map((r) => {
    const todayForFeed = typeof today === "string" ? today : today(r.indicator.feedTimeZone);
    const f = resolveFreshness(r.indicator, r.date, todayForFeed, calendars);
    return f === null ? { ...r } : { ...r, ...f };
  });
}

/**
 * THE run path's one freshness resolution (pass 2 of {@link stampFreshness}'s two-pass shape),
 * exported so the ONE caller that holds no `Reading` — the absent-member carry gate
 * (`carryAbsentMembers`, dial-assembly.ts, whose members are by definition missing from this run's
 * readings and so have no stamp to look up) — resolves through THIS function rather than reaching
 * for `assessIndicatorFreshness`/`assessFreshness` a second time. That is what keeps
 * `src/run-path-freshness-callers.test.ts` green: this file stays the run path's sole freshness
 * COMPUTATION, the only other permitted caller being run-core.ts's deliberately calendar-day
 * whole-run heartbeat. That is what keeps the unit and the cut in lockstep across both sites.
 *
 * `daily`/`weekly` ⇒ PUBLICATION SLOTS (`slotAge` against the id's containment grid) scored against
 * `lagCutFor`; `monthly`/`quarterly` ⇒ CALENDAR days through the unchanged `assessIndicatorFreshness`.
 * `null` ⇒ NOT ASSESSED — a daily/weekly target for which no grid could be built (see
 * {@link lagCalendarsFrom}'s ⚠); callers must fail toward "no claim", never toward "fresh". Pure.
 */
export function resolveFreshness(
  indicator: Pick<Indicator, "id" | "cadence" | "lagAfterDays">,
  asOf: string,
  today: string,
  calendars: LagCalendars,
): Freshness | null {
  const cadence = indicator.cadence ?? "daily";
  if (cadence !== "daily" && cadence !== "weekly") {
    return assessIndicatorFreshness(asOf, today, cadence, indicator.lagAfterDays);
  }
  const grid = calendars.gridFor(indicator.id);
  if (grid === null) return null;
  // Excused = the id's source/publisher closures in `(asOf, today]` (market-closures.ts). ⚠ Keyed by the id ITSELF,
  // where `freshnessFrom` keys a composite leg by its PARENT grid target — latent: `CMP_*` rows are display-only
  // vintage rows (run-cycle-feeds.ts) and never reach `stampFreshness`; a leg stamped here would read behind on its
  // parent's closures.
  const age = slotAge(asOf, today, grid, (d, post) => isSlotExcused(indicator.id, d, post));
  // `age - releaseDelay(id) > cut` — the feed's own measured T+1 delay is not lateness (release-delay.ts).
  return { lag: slotLag(age, lagCutFor(indicator), indicator.id), ageDays: age, unit: "slots" };
}

/**
 * Shared shape for the velocity/level `*ReadingSeries` scorers (Stage-D8 refactor):
 * the guard, the optional `resolveBands` call, the per-day classify loop, and the
 * `buildReadings` hand-off — the bespoke alignment + headline transform stay in the
 * caller. `classify` sees the resolved bands (both null when `bands` is omitted) and
 * closure-captures any extra columns (NVDA, dgs2/dgs10, MA) it needs.
 */
export interface SeriesSpec {
  /** Exact guard: values.length < minLength → return []. Derived per scorer from its
   *  live guard (WINDOW, WINDOW+1, or the `<=` form) — verify at migration time. */
  minLength: number;
  /** Loop start AND buildReadings offset — identical in all 11 scorers (WINDOW or WINDOW−1). */
  baseOffset: number;
  /** resolveBands args (threshold-config.ts seam — MUST-PRESERVE). Omit entirely for F5. */
  bands?: { amber: number | null; red: number | null; firesHighward: boolean };
  /** Per-day raw state at index i over the headline series; resolved bands passed in
   *  (both null when spec.bands is absent). Extra columns (NVDA, dgs2/dgs10, MA) are
   *  closure-captured by the caller. */
  classify: (i: number, values: number[], amber: number | null, red: number | null) => State;
  confirm?: boolean; // default true, passed through to buildReadings
  /** Optional per-day DECISION VARIABLE (the scalar the bands score against — e.g. a
   *  drawdown), index-aligned to the classify loop and forwarded to `buildReadings` as
   *  `decisions`. Omit for every level/velocity scorer whose decision reduces to a
   *  `derived` descriptor (`decisionAt` handles those); present only for a bespoke
   *  composite whose decision isn't a single-series `derived` transform (downside drawdown). */
  decisionOf?: (i: number, values: number[]) => number | null;
  /** Optional per-day winning OR-LEG token (`domain-legs.ts`' `+`-joined grammar), index-aligned
   *  to the classify loop and forwarded to `buildReadings` as `rawLegs` — plus, gated on
   *  raw-agrees-with-confirmed, as `legs`. Omit for every scorer whose state is a single
   *  undifferentiated read; present only where the descriptor scores TWO legs the board and the
   *  push can name (BONOS today). The gate is `scoreDaySeries`' rule verbatim (domain-fold.ts): a
   *  coloured cell is never attributed to a leg the RAW day disagrees with. */
  legOf?: (i: number, values: number[]) => string | undefined;
}

/**
 * The shared velocity/level series builder (Stage-D8 refactor). `values`/`dates` are
 * already aligned + transformed by the caller (ratio / spread / raw closes). Note (a):
 * the length-guard fires AFTER the caller's ratio/spread map — safe because those maps
 * are pure and length-preserving (`values.length` equals the pre-map aligned length), so
 * guarding here is extensionally identical to the scorers that guarded before mapping.
 */
export function ratioReadingSeries(
  indicator: Indicator,
  values: number[], // headline series, already aligned/transformed by the caller
  dates: string[], // index-aligned to values
  spec: SeriesSpec,
): Reading[] {
  if (values.length < spec.minLength) return [];
  const { amber, red } = spec.bands
    ? resolveBands(indicator.id, spec.bands.amber, spec.bands.red, spec.bands.firesHighward)
    : { amber: null, red: null };
  const rawStates: State[] = [];
  // `decisions` stays undefined unless the caller supplies `decisionOf`, so every existing
  // scorer is byte-identical (buildReadings then takes the `decisionAt` path as before).
  const decisions: (number | null)[] | undefined = spec.decisionOf ? [] : undefined;
  // Same contract as `decisions`: absent unless the caller supplies `legOf`, so every existing
  // scorer still hands `buildReadings` no legs and its readings keep `leg`/`rawLeg` undefined.
  const rawLegs: (string | undefined)[] | undefined = spec.legOf ? [] : undefined;
  for (let i = spec.baseOffset; i < values.length; i++) {
    rawStates.push(spec.classify(i, values, amber, red));
    if (decisions) decisions.push(spec.decisionOf!(i, values));
    if (rawLegs) rawLegs.push(spec.legOf!(i, values));
  }
  // The agreement gate, mirroring `scoreDaySeries` (domain-fold.ts): `legs` blanks on the days the
  // raw state disagrees with the confirmed one, `rawLegs` keeps them. Re-folding here rather than
  // reaching into `buildReadings` keeps that function's "legs come pre-gated from the caller's own
  // fold" contract intact — and the fold is the SAME primitive at the SAME per-indicator depth, so
  // the two cannot disagree. With `confirm: false` there is no confirmed series to gate against.
  const legs =
    rawLegs && rawStates.length > 0 && (spec.confirm ?? true)
      ? ((confirmed) => rawLegs.map((l, k) => (rawStates[k] === confirmed[k] ? l : undefined)))(
          asymConfirmedStateSeries(rawStates, confirmClosesFor(indicator.id)),
        )
      : rawLegs;
  return buildReadings(
    indicator,
    values,
    dates,
    rawStates,
    spec.baseOffset,
    spec.confirm ?? true,
    decisions,
    legs,
    rawLegs,
  );
}

/**
 * The per-point DECISION VARIABLE for a `derived`-described indicator, captured here
 * — the ONE place — so the persisted `decision` column is single-sourced at cron and
 * the read path (Stage 2/3) never re-derives it. Reuses the SAME `derivedValue`
 * transform + `derived` descriptor (kind + window) the scorer's bands read, applied to
 * the plotted `level` series (`values`), and the FE plots THIS persisted value verbatim
 * (no FE re-derivation exists), so it can't drift. For G1/NVDA this IS the exact scalar
 * `derivedRawStateSeries` already classifies into `rawState`; for F4/F8 it is the
 * same one-division return the bespoke scorer compares; for F5 it is the highDist line
 * the card plots. F6 does NOT route here — `relStrengthBreakReadingSeries` persists its
 * own decision (`decisionOf` = ratio ÷ MA200 − 1).
 * NULL when there is no `derived` descriptor, when kind is "identity" (no derived line),
 * or when the lookback window is short — a gap the FE renders as a line break.
 */
export function decisionAt(dv: DerivedView | undefined, values: number[], i: number): number | null {
  if (!dv || dv.kind === "identity" || dv.window == null) return null;
  // First index a full window is available: "return"/"change" need a window-back point (i ≥ window);
  // "maSpread"/"highDist"/"lowRise"/"worstDrop" use an inclusive window ending at i (i ≥ window − 1). Below it → gap.
  const firstIndex = isWindowBack(dv.kind) ? dv.window : dv.window - 1;
  if (i < firstIndex) return null;
  return derivedValue(dv.kind, values, i, dv.window);
}

/**
 * Min-observation guard shared by every scalar scorer (Stage-2 refactor): throw a
 * uniform message when the input was too short to confirm a state (a 1-element
 * history silently bypasses the buffer), else return the latest reading. `need`/`got`
 * are the min and actual input lengths; `noun` labels what was counted ("observations"
 * or "aligned closes").
 */
export function latest(
  indicator: Indicator,
  series: Reading[],
  need: number,
  got: number,
  noun = "observations",
): Reading {
  if (got < need) {
    throw new Error(`[${indicator.id}] need ${need} ${noun}, got ${got}`);
  }
  return series.at(-1)!;
}

/**
 * A scalar scorer's series for the gap-fill carrier: the twin's rows dated BEFORE `newest`, then
 * `newest` itself — so the persisted newest row (and any guard throw) stays the scalar's, byte-for-byte.
 */
export function withNewest<T extends { date: string }>(series: readonly T[], newest: T): T[] {
  return [...series.filter((r) => r.date < newest.date), newest];
}

/**
 * Per-day regime-relative z for the OWN-series measured leg (R1/R5/EBP), aligned to
 * `observations[VELOCITY_WINDOW..]` so it threads straight into `rawStateSeries`
 * (whose alignment guard then fails loud on any off-by-one). Built ONLY for
 * own-series indicators (`usesOwnSeriesZ`) — i.e. the ids whose `CALIB_MAP` entry sets
 * `ownZ`; every other id (unmapped, velocity-only, or mapped without `ownZ`) has no
 * own-series `zref` here. Absent calib (or a missing `zref`) ⇒ `undefined`
 * entries ⇒ `rawStateSeries` skips the z-leg ⇒ exact absolute-only behavior.
 */
function ownSeriesZ(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
): ReadonlyArray<number | undefined> | undefined {
  if (!calib || !usesOwnSeriesZ(indicator.id)) return undefined;
  return observations.slice(VELOCITY_WINDOW).map((o) => calibratedZ(o.value, calib.zrefMean, calib.zrefStd));
}

/**
 * FRED level+velocity indicator as a FULL per-day `Reading[]` series (oldest→
 * newest), aligned to `observations[VELOCITY_WINDOW..]` — the series-as-primitive
 * shape. The backfill persists the
 * historical days; scoreIndicator takes the last for the live commit reading. Raw
 * states route through the CONFIRM_CLOSES buffer (via buildReadings), so each day's
 * `state` is the real confirmed-as-of-that-day value. Guard-light like rawStateSeries.
 * `calib` (the resolved measured cut-points) threads the optional own-series z-leg.
 * The ONE shared series builder for ALL of R1–R5 + EBP — a recompute-on-read caller
 * needs no per-indicator branching (ownSeriesZ/usesOwnSeriesZ auto-gate the z-leg per id;
 * only R1/R5/EBP). The z/EVT leg (calibratedZ, domain-cuts.ts) is a POINTWISE scalar, NOT a
 * rolling window, so leading-history padding is only VELOCITY_WINDOW(20) + CONFIRM_CLOSES(2)
 * — NOT replay.ts's unrelated CREDIT_WARMUP=252. getStore().getSeries(id,limit) returns only
 * the newest `limit` dates, so a padding caller must request `limit + PAD` and slice down.
 */
export function indicatorReadingSeries(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
  proxyOverride?: ProxyLegSeries,
  shortLeg?: Observation[],
): Reading[] {
  // `proxyOverride` wins over the own-series z when a caller passes one; absent ⇒ own-series z
  // (R1/R5/EBP) ⇒ undefined for everything else. ⚠ NO CALLER PASSES IT since Stage 5.2
  // (2026-08-06) deleted the F1/F2 borrowed-leg producer — the parameter is a dormant seam, and
  // its unreachability is tracked in `docs/backlog.md`, not a live path to reason about.
  const proxy = proxyOverride ?? { z: ownSeriesZ(indicator, observations, calib) };
  // ONE fold for both halves (D3 Stage 2.1): the per-day `leg` rides along at no extra
  // cost on the cron path — the payoff Stage 2.0's `scoreDaySeries` extraction was staged
  // for. `confirmClosesFor` matches the buffer `buildReadings` folds `state` through, so
  // the attribution-suppression gate agrees with the emitted confirmed state.
  const { rawStates, legs, rawLegs } = scoredDaySeries(
    indicator,
    observations,
    calib,
    proxy,
    confirmClosesFor(indicator.id),
  );
  const values = observations.map((o) => o.value);
  const dates = observations.map((o) => o.date);
  // A cooldown rung floors the per-day raw state BEFORE the confirm fold, so replay/restate reproduce it.
  // The always-on drawdown leg is NOT gated on the rung: it rides the same fold but fires whether or not
  // the rung is armed. Both un-wired from R1 since 2026-08-31 — this path now serves fixture carriers only.
  const legFires = indicator.drawdownLeg
    ? drawdownLegSeries(observations, shortLeg, indicator.drawdownLeg)
    : undefined;
  const cooled =
    indicator.postInversionCooldown
      ? withPostInversionFloor(
          rawStates,
          postInversionFloorSeries(values, indicator.postInversionCooldown, dates),
          steepenerEscalationSeries(observations, shortLeg, indicator.postInversionCooldown),
          VELOCITY_WINDOW,
          legFires,
        )
      : legFires
        ? // No rung: an all-off `fires` never reads `escalates` (RED needs `fires[i]`), so none is built.
          withPostInversionFloor(rawStates, new Array<boolean>(observations.length).fill(false), [], VELOCITY_WINDOW, legFires)
        : rawStates;
  return buildReadings(indicator, values, dates, cooled, VELOCITY_WINDOW, true, undefined, legs, rawLegs);
}

/**
 * Per-day winning OR-leg aligned index-for-index to `indicatorReadingSeries` — the
 * read-API companion that resolves the SAME own-series z (the read edge passes no proxy override)
 * and folds it through `winningLegSeries`. Kept separate from the reading series so the
 * per-point `leg` rides the DTO only (not the persisted `Reading`). Slice both by the
 * same `-limit` to keep them aligned.
 */
export function indicatorLegSeries(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
): Array<string | undefined> {
  const proxy = { z: ownSeriesZ(indicator, observations, calib) };
  return winningLegSeries(indicator, observations, calib, proxy, confirmClosesFor(indicator.id));
}

export function scoreIndicator(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
  proxyOverride?: ProxyLegSeries,
  shortLeg?: Observation[],
): Reading {
  // Need enough history for at least CONFIRM_CLOSES raw states, else the
  // confirmation buffer is silently bypassed (a 1-element history can't confirm).
  const minObs = VELOCITY_WINDOW + CONFIRM_CLOSES;
  return latest(
    indicator,
    indicatorReadingSeries(indicator, observations, calib, proxyOverride, shortLeg),
    minObs,
    observations.length,
  );
}

// --- Derived-variable scorers (G1 oil + NVDA gate) -------------------------
//
// G1 oil is keyless FRED (DCOILWTICO), so it FETCHES through fetchSeries like the
// other FRED series, but it SCORES bespoke: a geopolitical oil spike is a PERCENT
// move ($20 vs $120 oil), not the absolute level+velocity the credit/rate
// indicators use. The NVDA gate scores on its % distance from MA200. Both are
// exactly what the `derived` descriptor on each Indicator already declares (the
// same descriptor the detail chart reads), so they share one generic scorer that
// reads `derived` — the decision-variable math (transform + bands) lives in ONE
// place and the chart and scorer can't drift. escalatorFloor counts one elevated
// GEO reading (oil) as one geo flag. (F4/F5 keep bespoke rules below — compound
// MA200/NVDA gate, "rising" sub-condition — that `derived` can't express.)

// The oil cuts live on `G1_DESCRIPTOR`/`BRENT_DESCRIPTOR` (family-descriptor-rows.ts, Stage 2b.1);
// `G1_AMBER_RET`/`G1_RED_RET` are re-exported from this module at the top of the file, and the
// LEVEL-gate window + combine mode are read by `oilReadingSeries` off `GEO_HYBRID_DESCRIPTOR_OF`.

/** Mean of values[start..end] inclusive. */
export function mean(values: number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += at(values, i);
  return sum / (end - start + 1);
}

/** Max of values[start..end] inclusive. */
export function maxOf(values: number[], start: number, end: number): number {
  let m = at(values, start);
  for (let i = start + 1; i <= end; i++) if (at(values, i) > m) m = at(values, i);
  return m;
}

/** Min of values[start..end] inclusive. */
export function minOf(values: number[], start: number, end: number): number {
  let m = at(values, start);
  for (let i = start + 1; i <= end; i++) if (at(values, i) < m) m = at(values, i);
  return m;
}

/**
 * The decision variable per day for a `derived`-described indicator, with these
 * window semantics (the single source; the FE plots the persisted result, or KBE's on-read stamp in api/series.ts):
 *  - "return":   v[i] / v[i-window] - 1
 *  - "maSpread": v[i] / mean(window ending at i) - 1
 *  - "highDist": v[i] / max(window ending at i) - 1
 *  - "lowRise":  v[i] - min(window ending at i) — LEVEL units, no base guard (a difference
 *                is meaningful for any finite pair, unlike the ratio kinds)
 *  - "worstDrop": min over k in the window ending at i of v[k] / max(v[start..k]) - 1 — the probe's
 *                `worstDrop` (`scripts/probe-value-tranches.ts`), NOT highDist (equal only when the trough is v[i])
 *  - "change":   v[i] - v[i-window] — LEVEL units, no base guard (ESTR sat negative 2019–22)
 * The ratio kinds ("return"/"maSpread"/"highDist") return null on a zero/non-positive/non-finite
 * base; "change" returns null only on a non-finite difference — the caller maps null →
 * GREEN, which reproduces oil's negative-WTI guard (the 2020 negative-WTI episode
 * makes the percent move meaningless → no shock) and never bites a positive price
 * series. `identity` plots the value directly.
 */
function derivedValue(kind: DerivedKind, v: number[], i: number, window: number): number | null {
  if (kind === "identity") return at(v, i);
  const ratio = (base: number) => (base > 0 && Number.isFinite(base) ? at(v, i) / base - 1 : null);
  if (kind === "return") return trailingReturnAt(v, i, window);
  if (kind === "change") {
    const d = at(v, i) - at(v, i - window);
    return Number.isFinite(d) ? d : null;
  }
  if (kind === "maSpread") return ratio(mean(v, i - window + 1, i));
  if (kind === "lowRise") return at(v, i) - minOf(v, i - window + 1, i);
  if (kind === "worstDrop") return worstDropAt(v, i - window + 1, i);
  return ratio(maxOf(v, i - window + 1, i)); // highDist
}

/** Worst `v[k] / runningMax − 1` over `[start, end]`, the running max reset at `start`; null on a non-positive/non-finite high. */
function worstDropAt(v: number[], start: number, end: number): number | null {
  let hi = -Infinity;
  let worst = 0;
  for (let k = start; k <= end; k++) {
    hi = Math.max(hi, at(v, k));
    if (!(hi > 0 && Number.isFinite(hi))) return null;
    worst = Math.min(worst, at(v, k) / hi - 1);
  }
  return worst;
}

/**
 * Trailing `window`-day return at index `i`: `v[i] / v[i-window] - 1`, null on a
 * zero/non-positive/non-finite base — the same base test the retired harness.py's `_return_rows`
 * applied. Scalar because `derivedValue` is called once per index — an array-only
 * form would make `derivedRawStateSeries` quadratic.
 */
export function trailingReturnAt(v: number[], i: number, window: number): number | null {
  const base = at(v, i - window);
  return base > 0 && Number.isFinite(base) ? at(v, i) / base - 1 : null;
}

/**
 * `trailingReturnAt` over a whole series, aligned to `values[window..]` (matching
 * `derivedBaseOffset`'s "return" offset). The live formula, extracted so the backtest
 * constants emitter publishes a fixture computed by the REAL source (D0 Stage 2.1).
 *
 * NOT a shape-mirror of the retired harness.py's `_return_rows`: same base test, same non-null
 * values in the same order, but a bad base yields `null` IN PLACE here (length preserved) while
 * `_return_rows` DROPPED the row (length shrinks). Behaviour-equivalent on the live G1 oil
 * path — both meant "no live decision variable" — so this was a doc distinction, not a bug.
 *
 * NOTE: `scoreSemis` computes its own UNGUARDED `s[i]/s[i-RET_WINDOW]-1` — it has
 * different null semantics and is deliberately NOT folded in here.
 */
export function trailingReturn(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = window; i < values.length; i++) out.push(trailingReturnAt(values, i, window));
  return out;
}

/**
 * Classify a derived value against its descriptor's bands. Polarity is read off the
 * descriptor: "highDist" and a positive-band "return"/"change" are HIGH (breach when the
 * variable rises to/through the band — oil's +20/+40% shock, a new high); "maSpread"
 * and a negative-band "return"/"change" are LOW (breach when it falls below — NVDA below its
 * MA200, a drawdown, a fast ESTR cut). Every band is INCLUSIVE on both branches: oil's `>=` (the +20/+40%
 * calibration) and, since row 18, the LOW branch's
 * `d <= amber` alongside its already-inclusive `d <= red`. A null decision variable (bad
 * base) is GREEN. `red === null` ⇒ that band never fires.
 *
 * ⚠ CROSS-SEAM DIVERGENCE ON THE TIE DAY — RULED INTENTIONAL 2026-08-09 [USER]: a CARD warns
 * on touch, a GATE trips only on breach. At `close === MA200` (NVDA's amber is 0) the card
 * reads AMBER while both MA200 gate consumers stay STRICT — `scorers-price.ts`'s F4 Red gate
 * (`n[i]! < nvdaMA`) and `gates.ts`'s `belowMAFlags` (`values[i]! < (sum/window)*maMult`).
 * Do NOT align them. Unrealized so far: `npm run probe:low-tie` measures NVDA ties = 0 over
 * 3,588 scored NVDA-days.
 */
/**
 * Whether a `derived` descriptor's bands fire HIGHWARD (breach when the decision variable
 * rises to/through the band) — mirrors `classifyDerived`'s `high`. Drives the earliness
 * direction at the `resolveBands` seam: highward ⇒ m<1 moves the band DOWN toward danger;
 * a LOW-firing descriptor (maSpread / negative-band return or change) moves it UP.
 */
export function derivedFiresHighward(dv: DerivedView): boolean {
  return dv.kind === "highDist" || dv.kind === "lowRise" || (isWindowBack(dv.kind) && (dv.amber ?? 0) >= 0);
}

/** The window-back kinds ("return" ratio, "change" difference): one polarity rule (band sign) and
 *  one offset (i ≥ window) — they differ ONLY by the transform in `derivedValue`. */
function isWindowBack(kind: DerivedKind): boolean {
  return kind === "return" || kind === "change";
}

function classifyDerived(d: number | null, dv: DerivedView): State {
  if (d === null) return "GREEN";
  const { amber, red } = dv;
  const high = derivedFiresHighward(dv);
  if (high) {
    if (red !== null && d >= red) return "RED";
    if (amber !== null && d >= amber) return "AMBER";
    return "GREEN";
  }
  if (red !== null && d <= red) return "RED";
  // Inclusive, matching the RED branch's `d <= red` one line above (row 18 / CORE-B6).
  // It used to be strict `<`, so a decision variable sitting
  // EXACTLY on the amber cut read GREEN while the same value on the red cut read RED — one
  // classifier, two boundary conventions. The HARD GATE replay (`npm run probe:low-tie`) put
  // the changed-day count at 0 over 18,268 scored INDICATOR-days (5 ids × ~3.7k days each,
  // of which only NVDA and GT actually route here), so this is a convention fix, not a
  // retune. Highward's `d >= amber` above was already inclusive; all three now agree.
  if (amber !== null && d <= amber) return "AMBER";
  return "GREEN";
}

/**
 * A derived indicator's bands AFTER the threshold-config seam — the exact pair
 * `derivedRawStateSeries` scores the card with. Exported so a consumer that already holds
 * the decision variable (not the observation history) can read the SAME cuts.
 */
export function resolvedDerivedBands(indicator: Indicator): { amber: number | null; red: number | null } {
  const dv = indicator.derived;
  if (!dv) throw new Error(`[${indicator.id}] no derived descriptor`);
  return resolveBands(indicator.id, dv.amber, dv.red, derivedFiresHighward(dv));
}

/**
 * Classify an ALREADY-COMPUTED decision variable (e.g. GT's persisted `decision` maSpread)
 * against its indicator's RESOLVED bands — the same resolveBands + classifyDerived pair the
 * scored card runs. Exists so a consumer holding only the persisted decision
 * (`src/exposure.ts`'s FIRE key) consumes the card's verdict instead of re-testing the raw
 * variable against a cut of its own (CORE-B4: one input, two verdicts).
 * `d === null` returns GREEN (classifyDerived's contract) — callers that must not read a
 * missing input as "all clear" guard the null BEFORE calling.
 */
export function scoreDerivedDecision(indicator: Indicator, d: number | null): State {
  const dv = indicator.derived!;
  const { amber, red } = resolvedDerivedBands(indicator);
  return classifyDerived(d, { ...dv, amber, red });
}

/** First observation index a derived scorer can emit from: the window-back kinds ("return"/"change")
 *  need a full window-back point (i = window); "maSpread"/"highDist"/"lowRise"/"worstDrop" use an inclusive
 *  window ending at i (i = window - 1). "identity" has no window → starts at 0. */
function derivedBaseOffset(dv: DerivedView): number {
  if (dv.kind === "identity") return 0; // no window (would be `undefined - 1` → NaN)
  return isWindowBack(dv.kind) ? dv.window! : dv.window! - 1;
}

/**
 * Raw (unconfirmed) derived state per day (oldest→newest), aligned to
 * `observations[derivedBaseOffset..]`. Extracted so the backtest harness
 * (scripts/backtest/replay.ts) replays the EXACT oil rule by folding these through
 * `deriveConfirmedState` — single source of truth, no length guard.
 *
 * Sole-rule ids (via `derivedReadingSeries`): NVDA, GT, ESTR; G1/BRENT take it only as the
 * velocity leg `trailingPeakLegs` combines with a level gate. F4/F5 are ALSO `derived`-described, but
 * their live rules are compound (F4's MA200+NVDA gate, F5's "rising" sub-condition)
 * and stay bespoke (semis/breadthReadingSeries) — routing them here would silently
 * drop those legs. S1's TRACKS interface is the place to enforce this structurally.
 */
export function derivedRawStateSeries(
  indicator: Indicator,
  observations: Observation[],
  config?: ThresholdConfig, // undefined = the file-loaded threshold-config.json
): State[] {
  const dv = indicator.derived;
  if (!dv) throw new Error(`[${indicator.id}] no derived descriptor`);
  const v = observations.map((o) => o.value);
  const baseOffset = derivedBaseOffset(dv);
  // Scale the descriptor's bands through the config seam (the SAME resolveBands + firesHighward
  // the display edge uses in scaleDerived), so the scored ribbon and the drawn line move together.
  const fh = derivedFiresHighward(dv);
  const { amber, red } = resolveBands(indicator.id, dv.amber, dv.red, fh, config);
  const scored: DerivedView = { ...dv, amber, red };
  const states: State[] = [];
  for (let i = baseOffset; i < v.length; i++) {
    states.push(classifyDerived(derivedValue(dv.kind, v, i, dv.window!), scored));
  }
  return states;
}

/**
 * Derived-variable indicator as a FULL per-day `Reading[]` series (oldest→newest).
 * `confirm` defaults true (oil folds through the CONFIRM_CLOSES buffer like the FRED
 * indicators); the NVDA gate passes `confirm: false` (raw === state, no buffer — the
 * card mirrors the gate's raw daily compare). The stored `delta20` is the honest
 * absolute change of the headline level; only the confirmed `state` uses the derived
 * variable — same split as scoreSemis. Guard-light (the scalar wrappers keep the
 * min-observation guard). Pure: no IO.
 */
export function derivedReadingSeries(
  indicator: Indicator,
  observations: Observation[],
  confirm = true,
): Reading[] {
  const dv = indicator.derived!;
  const rawStates = derivedRawStateSeries(indicator, observations);
  const values = observations.map((o) => o.value);
  const dates = observations.map((o) => o.date);
  return buildReadings(indicator, values, dates, rawStates, derivedBaseOffset(dv), confirm);
}

/** Latest confirmed reading for an id whose `derived` block is its SOLE rule (ESTR's "change"). */
export function scoreDerived(indicator: Indicator, observations: Observation[]): Reading {
  const need = derivedBaseOffset(indicator.derived!) + CONFIRM_CLOSES;
  return latest(indicator, derivedReadingSeries(indicator, observations), need, observations.length);
}

/**
 * The oil LEVEL leg — a binary GATE, not a severity band. Hamilton's *net oil price increase*
 * is the excess of the price over its prior 3-year peak and ZERO otherwise: a big run-up that
 * fails to breach the trailing peak is a rally off a low, not the oil shock that breaks the
 * cycle, and a pure-velocity read cannot tell the two apart.
 *
 * The compare is against the PRIOR window (`[i - window, i)`, current point EXCLUDED), so an
 * equal-to-peak close gates ON.
 *
 * ⚠ **Insufficient history ⇒ gate ON**, deliberately — this binary DRAWN-gate helper stays
 * fail-open; the SCORED graded leg (`levelGateState`) degrades GREEN instead, and for `i ≥ window`
 * this flag ≡ its RED rung. Pinned by `crisis-indicators.test.ts` §"underrun degrades GREEN,
 * deliberately DIVERGING from levelGateOn's degrade-to-ON".
 */
export function levelGateOn(values: number[], i: number, window: number): boolean {
  if (i - window < 0) return true;
  return at(values, i) >= trailingPriorPeak(values, i, window);
}

/** Max over the PRIOR window `[i - window, i)`, current point excluded. Caller guards `i ≥ window`. */
function trailingPriorPeak(values: number[], i: number, window: number): number {
  let peak = -Infinity;
  for (let j = i - window; j < i; j++) if (at(values, j) > peak) peak = at(values, j);
  return peak;
}

/**
 * Join the level leg to the velocity band under the descriptor's `combine` mode. Exported so
 * BOTH modes are directly testable without editing a shipped descriptor — the flip itself is a
 * one-word data edit on `GeoHybridDescriptor.combine`.
 *
 * Both arguments are STATES, not a boolean and a state (widened 2026-08-06 slice 2). A
 * `"trailing-peak"` level leg is binary and reaches here as `"RED"`/`"GREEN"` via
 * `levelGateState`; a `"fixed"` level leg is a severity BAND with a real amber arm (OVX),
 * and faking that band into a gate boolean would silently drop its AMBER rung.
 *
 * - `"and"` — the level leg ADMITS the velocity read; level GREEN ⇒ GREEN regardless of velocity.
 *   Any non-GREEN level is an open gate: the gate is a permission, its severity is not the output.
 * - `"or"` — either leg alone fires, so the result is the WORSE of the two.
 * - `"split"` (2026-08-08, CG) — the band is SPLIT across the two legs: RED requires BOTH legs RED
 *   (`min(level, velocity) === RED`), while EITHER leg at ≥AMBER yields AMBER. It is neither of the
 *   other two: `"or"` would let one leg alone reach RED, `"and"` has no AMBER rung of its own.
 *   The 3×3 lattice (level down, velocity across):
 *
 *       |        | GREEN | AMBER |  RED  |
 *       | GREEN  | GREEN | AMBER | AMBER |
 *       | AMBER  | AMBER | AMBER | AMBER |
 *       |  RED   | AMBER | AMBER |  RED  |
 *
 *   Cross-confirmation for RED, single-leg heads-up for AMBER — the shape that kills a
 *   single-indicator false positive without muting the leg that fired.
 *
 * Behaviour on a binary level leg is unchanged by the widening: `"and"` was `gateOn ? velocity :
 * "GREEN"`, and `"or"` was `gateOn ? "RED" : velocity` = `worse("RED"|"GREEN", velocity)`.
 *
 * ⚠ `"and"` HAS NO SHIPPED ID AT ALL since G1/BRENT flipped to `"split"` (2026-08-11), and the
 * branch above is written to be right if one ever ships: were an AMBER level leg gated under `"and"`, it would FULLY
 * admit the velocity read (`level !== "GREEN"` ⇒ return `velocity` verbatim) — an amber gate is as
 * open as a red one, and it can never CAP the velocity severity it admits. That is the intended
 * reading of "the gate is a permission, its severity is not the output", stated here so a future
 * `"fixed" + "and"` descriptor is not written expecting a min-fold.
 */
export function combineLevelVelocity(
  combine: "and" | "or" | "split",
  level: State,
  velocity: State,
): State {
  if (combine === "and") return level === "GREEN" ? "GREEN" : velocity;
  if (combine === "split") {
    if (level === "RED" && velocity === "RED") return "RED";
    return level !== "GREEN" || velocity !== "GREEN" ? "AMBER" : "GREEN";
  }
  if (level === "RED" || velocity === "RED") return "RED";
  return level === "AMBER" || velocity === "AMBER" ? "AMBER" : "GREEN";
}

/**
 * The trailing-peak level leg as a GRADED STATE (2026-08-11, ex-binary): RED at/above the prior
 * `window` peak, AMBER at ≥ `proximity` × peak, else GREEN. `proximity` 1 (the default) makes the
 * AMBER rung unreachable — the old binary read.
 *
 * ⚠ Underrun (`i < window`) degrades to GREEN, DIVERGING from `levelGateOn`'s degrade-to-ON: under
 * `"split"` a RED level alone fires AMBER, so degrading ON would manufacture a standing AMBER over
 * every quiet short-history stretch (the first ~3 years of a backfill). RED therefore requires a
 * RESOLVABLE peak; a red run-up on short history caps at the AMBER the velocity leg carries. A
 * future `"and"` + trailing-peak id must NOT use this helper's degrade — it needs `levelGateOn`'s.
 */
export function levelGateState(values: number[], i: number, window: number, proximity = 1): State {
  if (i - window < 0) return "GREEN";
  const peak = trailingPriorPeak(values, i, window);
  if (at(values, i) >= peak) return "RED";
  return at(values, i) >= peak * proximity ? "AMBER" : "GREEN";
}

/**
 * The FIXED level band (`level: "fixed"`) — the id's own registry `thresholds` pair, compared with
 * the SAME strict `>`/`<` convention semantics the generic path's `op` leg uses (`evaluateLegs`,
 * domain-legs.ts), flipping with `direction`. This is what keeps OVX's level leg byte-identical to
 * what `scoreIndicator` scored before it joined the family: the id resolves NO calibration cut
 * (no `CALIB_MAP` entry), so the registry pair was already the whole `op` leg.
 */
export function fixedLevelState(indicator: Indicator, level: number): State {
  const { amberLevel, redLevel } = indicator.thresholds;
  const fired = (b: number | undefined): boolean =>
    b !== undefined && (indicator.direction === "LOW" ? level < b : level > b);
  if (fired(redLevel)) return "RED";
  if (fired(amberLevel)) return "AMBER";
  return "GREEN";
}

/**
 * The ONE oil scorer (v4 §4/§6.4 Family C) — G1/WTI and BRENT since the 2026-08-06 merge that
 * folded `scoreBrent` in. Two legs, joined by
 * the descriptor's `combine`:
 *
 *  - VELOCITY — the `derived` 20-trading-day return/ROC classification, via `derivedRawStateSeries`,
 *    so it routes through `resolveBands` (the `src/threshold-config.ts` multiplier seam) and the
 *    scored ribbon moves with the drawn band.
 *  - LEVEL — `levelGateOn` over the descriptor's `levelWindow` trailing peak.
 *
 * ⚠ ASYMMETRIC SEAM (§4.9), narrowed by the merge: the velocity arm is multiplier-scaled, the
 * level arm is not — but the level arm no longer carries a tunable at all (the fixed
 * `BRENT_RED_LEVEL = $100` is retired), so there is nothing left for a multiplier to move. The
 * trailing peak self-recalibrates off the series and is never retuned.
 *
 * ⚠ PRICE=SPLIT, VOL=OR — stated ONCE, here, since this is where the two meet. For a PRICE series
 * (`combine: "split"`, 2026-08-11, ex-`"and"`) RED needs BOTH legs — velocity without a
 * trailing-peak breach is a rally, not a shock — while EITHER leg alone is an AMBER heads-up
 * (Hamilton's exceedance is graded, not binary; Kilian & Vigfusson keep the uncensored velocity
 * signal alongside the net-increase term). For a VOL series (OVX, joined 2026-08-06) the spike is
 * informative on its own off a low base, so its legs are a DISJUNCTION and the worse of the two
 * wins. The asymmetry is the point, not an inconsistency.
 *
 * The two LEG SHAPES are also asymmetric, per `GeoHybridDescriptor.level`. A price id's level leg
 * is the binary trailing-peak gate; OVX's is the registry `thresholds` band. But BOTH shapes score
 * their VELOCITY leg off the registry `derived` block — OVX gained one in R5b — so for every id in
 * this family the drawn band, the persisted `decision` and the scored ribbon are one view by
 * construction, and both run it through `resolveBands` so the multiplier seam reaches them alike.
 *
 * escalatorFloor counts one elevated GEO reading as one geo flag (manual flags + auto oil share
 * the 1=WATCH / 2=WARNING calibration). The Red "or Hormuz flag" case (§4) is a separate manual
 * config flag. Folded through the CONFIRM_CLOSES buffer.
 */
export function oilReadingSeries(
  indicator: Indicator,
  observations: Observation[],
  config?: ThresholdConfig, // undefined = the file-loaded threshold-config.json
): Reading[] {
  const desc = GEO_HYBRID_DESCRIPTOR_OF[indicator.id];
  if (!desc) throw new Error(`[${indicator.id}] no geo-hybrid descriptor - add a GEO_HYBRID_DESCRIPTOR_OF row`);
  const values = observations.map((o) => o.value);
  const dates = observations.map((o) => o.date);
  const { baseOffset, velocityStates, levelStates } =
    desc.level === "trailing-peak"
      ? trailingPeakLegs(indicator, observations, desc, values, config)
      : fixedBandLegs(indicator, desc, values, config);
  const rawStates = velocityStates.map((velocity, k) =>
    combineLevelVelocity(desc.combine, at(levelStates, k), velocity),
  );
  return buildReadings(indicator, values, dates, rawStates, baseOffset, true);
}

/** One id's two legs, index-aligned to each other and to `values[baseOffset..]`. */
interface OilLegs {
  baseOffset: number;
  velocityStates: State[];
  levelStates: State[];
}

/** PRICE ids (G1/BRENT): registry-`derived` velocity band + the binary trailing-peak level gate. */
function trailingPeakLegs(
  indicator: Indicator,
  observations: Observation[],
  desc: GeoHybridDescriptor,
  values: number[],
  config?: ThresholdConfig,
): OilLegs {
  const dv = indicator.derived;
  if (!dv) throw new Error(`[${indicator.id}] no derived descriptor`);
  const levelWindow = desc.scorer.constants.levelWindow;
  if (levelWindow == null) throw new Error(`[${indicator.id}] geo-hybrid descriptor has no levelWindow`);
  const proximity = desc.scorer.constants.peakProximity;
  if (desc.combine === "split" && proximity == null)
    throw new Error(`[${indicator.id}] combine "split" needs a peakProximity constant - its AMBER rung has no cut`);
  const baseOffset = derivedBaseOffset(dv);
  const velocityStates = derivedRawStateSeries(indicator, observations, config);
  return {
    baseOffset,
    velocityStates,
    levelStates: velocityStates.map((_, k) => levelGateState(values, baseOffset + k, levelWindow, proximity ?? 1)),
  };
}

/**
 * VOL ids (OVX): the registry `thresholds` level BAND + the spike band from the registry `derived`
 * block. `baseOffset` stays `VELOCITY_WINDOW` — the offset the generic path used for this id — so
 * the emitted row set, the persisted history and `scoreOil`'s min-observation guard are all
 * unchanged by the merge. That is the ONE thing this path does not take from `derived`
 * (`derivedBaseOffset` would start at the spike window instead); the spike window is far shorter
 * than `VELOCITY_WINDOW`, so it always resolves within that lead-in and no deeper feed history is
 * owed.
 *
 * ⚠ NO PER-DAY LEG ATTRIBUTION, AND THAT IS INERT (2026-08-06 review I3). This path passes neither
 * `legs` nor `rawLegs` to `buildReadings`, so every OVX `Reading.leg` is `undefined` — the same as
 * before the merge, since the generic path's attribution was also gated. Both consumers of
 * `Reading.leg` are keyed on `DUAL_AXIS_ID_SET` FIRST (`driverAxisNote`, src/notify_format.ts:94;
 * `velocityFiringCount`, src/domain-legs.ts:157), and the canonical `DUAL_AXIS_IDS` list
 * (domain-legs.ts) is `F1 F2 F3 F10 CCC T10YIE T5YIFR` (F9 left it 2026-08-07 and F11
 * 2026-08-08, each with its retired level axis; BAA10Y retired outright 2026-08-11) — OVX is NOT a member.
 * So no push body and no diagnostic can read this field for OVX. Grep to re-establish it:
 * `grep -rn '\.leg\b' src/ api/ public/` → exactly those two live call sites. Seating OVX in
 * `DUAL_AXIS_IDS` is what would make attribution owed here.
 */
function fixedBandLegs(
  indicator: Indicator,
  desc: GeoHybridDescriptor,
  values: number[],
  config?: ThresholdConfig,
): OilLegs {
  const { velocityWindow, amberRet, redRet } = desc.scorer.constants;
  if (velocityWindow === undefined) throw new Error(`[${indicator.id}] geo-hybrid descriptor has no velocityWindow`);
  // N1 FALSIFIER — the registry-half twin of `scoreWithCuts`'s calibration falsifier (confirmers.ts).
  // `fixedLevelState` reads ONLY `amberLevel`/`redLevel`, so a VELOCITY pair added to this id's
  // registry `thresholds` would be silently dropped while the card kept drawing it. Exact-key
  // equality, not a subset test: a missing arm is also a defect here (OVX ships both).
  const keys = Object.keys(indicator.thresholds).sort().join(",");
  if (keys !== "amberLevel,redLevel") {
    throw new Error(
      `[${indicator.id}] fixed-band geo-hybrid expects exactly the level pair in registry thresholds, got {${keys}} - ` +
        `wire the extra leg into fixedBandLegs before shipping it`,
    );
  }
  // I3 FALSIFIER + the single source for the spike leg. The scored view IS the registry `derived`
  // block — the same object `derivedChart` draws the secondary band from and `decisionAt`
  // materializes the persisted `decision` column from — so the drawn line, the stored decision
  // variable and the scored state cannot describe different windows. Before this, `kind` and
  // `window` were stated twice (here off the descriptor, there off the registry) and agreed only
  // by coincidence. The registry block is documented as a MIRROR of these descriptor constants
  // (`registry.ts`, OVX), so pin that mirroring here: a literal typed over any of the four fields
  // throws rather than silently splitting the scorer from the chart.
  const spike = indicator.derived;
  if (
    !spike ||
    spike.kind !== "return" ||
    spike.window !== velocityWindow ||
    spike.amber !== (amberRet ?? null) ||
    spike.red !== (redRet ?? null)
  ) {
    throw new Error(
      `[${indicator.id}] fixed-band geo-hybrid scores its spike leg off the registry \`derived\` block, which must ` +
        `mirror the descriptor's spike constants - got ` +
        `{kind: ${spike?.kind}, window: ${spike?.window}, amber: ${spike?.amber}, red: ${spike?.red}}, ` +
        `descriptor says {kind: return, window: ${velocityWindow}, amber: ${amberRet}, red: ${redRet}}`,
    );
  }
  // Same `resolveBands` + `classifyDerived` pair the other `derived`-block ids score through — one
  // band convention (inclusive ≥) and one multiplier seam for the whole family.
  const { amber, red } = resolveBands(indicator.id, spike.amber, spike.red, true, config);
  const scored: DerivedView = { ...spike, amber, red };
  const velocityStates: State[] = [];
  const levelStates: State[] = [];
  for (let i = VELOCITY_WINDOW; i < values.length; i++) {
    velocityStates.push(classifyDerived(trailingReturnAt(values, i, spike.window), scored));
    levelStates.push(fixedLevelState(indicator, at(values, i)));
  }
  return { baseOffset: VELOCITY_WINDOW, velocityStates, levelStates };
}

export function scoreOil(indicator: Indicator, observations: Observation[]): Reading {
  const minObs = VELOCITY_WINDOW + CONFIRM_CLOSES;
  return latest(indicator, oilReadingSeries(indicator, observations), minObs, observations.length);
}

/**
 * Post-inversion floor rung (R1/R8 shared): per-day AMBER-floor flags over the RAW closes. Runs count
 * PRESENT obs — a date gap neither breaks nor extends a run; the knob values live on the registry object.
 */
export function postInversionFloorSeries(values: number[], cfg: PostInversionCooldown, dates: string[]): boolean[] {
  const cuts = postInversionCutSeries(values, cfg, dates);
  return values.map((v, i) => {
    const c = at(cuts, i);
    return c !== null && v < c;
  });
}

/** One armed expanding-percentile cut over the anchored pool; `warmupHold: null` ⇒ the cut is
 *  ABSENT (null) while the pool is under `cutWarmupObs`, a number ⇒ that hold value. */
export interface ArmedCutSpec {
  pctile: number;
  clamp: [number, number];
  warmupHold: number | null;
}

/** The armed expanding-pool walk itself, one output series per `spec` (null = unarmed/released/held-
 *  absent) — the ONE cut expression behind both the post-inversion floor and the R8 mean-space pair,
 *  over whatever series the caller arms it on (R1 hands it the 21-obs means).
 *  Arms on ≥`qualifyN` consecutive `values` < 0, releases on `releaseN` consecutive ≥ `floorLevel`;
 *  while armed each spec's cut is its clamped expanding percentile of the values dated ≥
 *  `cutAnchorDate` (`dates` aligned to `values`); a pool under `cutWarmupObs` holds `warmupHold`. */
export function armedExpandingCutSeries(
  values: number[],
  cfg: Pick<PostInversionCooldown, "qualifyN" | "floorLevel" | "releaseN" | "cutWarmupObs" | "cutAnchorDate">,
  dates: string[],
  specs: ArmedCutSpec[],
): Array<Array<number | null>> {
  const cuts = specs.map(() => new Array<number | null>(values.length).fill(null));
  const pool: number[] = []; // sorted expanding pool of anchored closes — today's obs enters BEFORE its cut
  let run = 0; // consecutive inverted closes ending today
  let armed = false;
  let healthy = 0; // consecutive closes ≥ floorLevel ending today, while armed
  for (let i = 0; i < values.length; i++) {
    const v = at(values, i);
    if (at(dates, i) >= cfg.cutAnchorDate) {
      let lo = 0;
      let hi = pool.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at(pool, mid) < v) lo = mid + 1;
        else hi = mid;
      }
      pool.splice(lo, 0, v);
    }
    run = v < 0 ? run + 1 : 0;
    if (run >= cfg.qualifyN) armed = true;
    if (!armed) continue;
    healthy = v >= cfg.floorLevel ? healthy + 1 : 0;
    if (healthy >= cfg.releaseN) {
      armed = false; // level release — re-arming needs a fresh ≥qualifyN episode
      healthy = 0;
      continue;
    }
    specs.forEach((s, k) => {
      at(cuts, k)[i] =
        pool.length < cfg.cutWarmupObs
          ? s.warmupHold
          : Math.min(s.clamp[1], Math.max(s.clamp[0], at(pool, Math.floor(s.pctile * (pool.length - 1)))));
    });
  }
  return cuts;
}

/** The per-day ARMED CUT itself (null = unarmed/released) — the post-inversion cut over whatever
 *  series the caller passes (R1 hands it the 21-obs means); the floor and the drawn /lab line
 *  (`api/series.ts` `bandCuts`) both read it, so score and line cannot drift. While armed the cut is
 *  the clamped expanding `cutPctile` percentile of the `values` dated ≥ `cutAnchorDate`; a pool under
 *  `cutWarmupObs` holds `floorLevel`. */
export function postInversionCutSeries(
  values: number[],
  cfg: PostInversionCooldown,
  dates: string[],
): Array<number | null> {
  if (cfg.cutPctile === undefined || cfg.cutClamp === undefined) {
    throw new Error("postInversionCutSeries needs cutPctile+cutClamp - a levelCuts carrier scores through meanLevelCutSeries");
  }
  return at(armedExpandingCutSeries(values, cfg, dates, [
    { pctile: cfg.cutPctile, clamp: cfg.cutClamp, warmupHold: cfg.floorLevel },
  ]), 0);
}

/** The R8 mean-space cut pair (null = unarmed/released; red also null during warm-up) — the ONE
 *  expression the scorer AND the drawn /lab lines (`api/series.ts` `bandCuts`) read, over the SAME
 *  means, so score and line cannot drift. `means`/`meanDates` are the trailing-mean series. */
export function meanLevelCutSeries(
  means: number[],
  meanDates: string[],
  cfg: PostInversionCooldown,
): { amber: Array<number | null>; red: Array<number | null> } {
  const lc = cfg.levelCuts;
  if (!lc) throw new Error("meanLevelCutSeries needs a levelCuts carrier");
  const [amber, red] = armedExpandingCutSeries(means, cfg, meanDates, [
    { pctile: lc.amber.pctile, clamp: lc.amber.clamp, warmupHold: cfg.floorLevel },
    { pctile: lc.red.pctile, clamp: lc.red.clamp, warmupHold: null },
  ]);
  return { amber: amber!, red: red! };
}

/** Per-obs bull-steepening flags over the SHORT-leg closes: the leg fell ≥ `shortLegDropBp` bp over
 *  the trailing `shortLegWindow` obs — the ONE gate expression (probe-steepener-gate.ts reads it too).
 *  `mode: "either"` takes the SAME walk direction-agnostically (|move| ≥ the threshold), which is what
 *  the always-on drawdown leg gates on (un-wired from R1 since 2026-08-31, pinned on fixture carriers);
 *  there is deliberately no second copy of the window walk. */
export function steepenerBullSeries(
  shorts: number[],
  cfg: Pick<PostInversionCooldown, "shortLegWindow" | "shortLegDropBp">,
  mode: "fall" | "either" = "fall",
): boolean[] {
  // The SIGNED move below is the one walk; the flag is only its comparison, so the drawn line
  // (`shortMoveSeries` → the chart's secondary axis) and this test read the SAME numbers.
  return signedShortMoveSeries(shorts, cfg.shortLegWindow).map((move) => {
    if (move === null) return false;
    const fall = -move; // a FALL in the short leg is a negative move
    return (mode === "either" ? Math.abs(fall) : fall) >= cfg.shortLegDropBp / 100;
  });
}

/** The short leg's SIGNED change over the trailing `w` obs (`shorts[i] - shorts[i-w]`), null until
 *  the window has filled. Negative = the short leg FELL (bull steepening). The ONE window walk: the
 *  gate flags above compare it, and the detail chart plots it as its own line so the escalation and
 *  drawdown gates are a visible crossing rather than an invisible AND-condition. */
export function signedShortMoveSeries(shorts: number[], w: number): Array<number | null> {
  return shorts.map((v, i) => (i < w ? null : v - at(shorts, i - w)));
}

/** Join the short leg onto `observations` BY DATE — the space every gate walk runs in. Returns the
 *  aligned short closes plus the observation index each came from; a day with no short-leg obs (or
 *  no `shortLeg` at all — a degraded fetch) is simply absent, which reads as "gate off" downstream. */
function joinShortLeg(
  observations: Observation[],
  shortLeg: Observation[] | undefined,
): { idx: number[]; shorts: number[] } {
  const idx: number[] = [];
  const shorts: number[] = [];
  if (shortLeg === undefined || shortLeg.length === 0) return { idx, shorts };
  const shortByDate = new Map(shortLeg.map((o) => [o.date, o.value]));
  observations.forEach((o, i) => {
    const v = shortByDate.get(o.date);
    if (v === undefined) return;
    idx.push(i);
    shorts.push(v);
  });
  return { idx, shorts };
}

/** Bull flags aligned to `observations` — the trailing window runs in JOINED (date-aligned) space;
 *  a day with no short-leg obs (or no `shortLeg` at all — a degraded fetch) stays false: gate off. */
export function steepenerEscalationSeries(
  observations: Observation[],
  shortLeg: Observation[] | undefined,
  cfg: Pick<PostInversionCooldown, "shortLegWindow" | "shortLegDropBp">,
  mode: "fall" | "either" = "fall",
): boolean[] {
  const out = new Array<boolean>(observations.length).fill(false);
  const { idx, shorts } = joinShortLeg(observations, shortLeg);
  steepenerBullSeries(shorts, cfg, mode).forEach((b, j) => {
    if (b) out[at(idx, j)] = true;
  });
  return out;
}

/** The gate's own DECISION VARIABLE, aligned to `observations`: the short leg's signed move over the
 *  trailing `w` JOINED obs. Same join and same walk `steepenerEscalationSeries` gates on — so the
 *  line `api/series.ts` ships to the chart and the flag the scorer tests can never drift. `null`
 *  where the day has no aligned short obs or the window has not filled (⇒ the renderer draws a gap,
 *  which is honest: on those days the gate is structurally off). */
export function shortMoveSeries(
  observations: Observation[],
  shortLeg: Observation[] | undefined,
  w: number,
): Array<number | null> {
  const out = new Array<number | null>(observations.length).fill(null);
  const { idx, shorts } = joinShortLeg(observations, shortLeg);
  signedShortMoveSeries(shorts, w).forEach((m, j) => {
    if (m !== null) out[at(idx, j)] = m;
  });
  return out;
}

/** Per-obs regime-relative drawdown CUT (null until the window has filled): the max of the trailing
 *  `window` obs INCLUSIVE of today, minus `dropPp`. The ONE cut expression — the leg below and the
 *  drawn /lab line (`api/series.ts` `bandCuts`) both read it, so score and line cannot drift. */
export function drawdownCutSeries(values: number[], cfg: DrawdownLeg): Array<number | null> {
  return values.map((_, i) => {
    if (i + 1 < cfg.window) return null;
    let hi = -Infinity;
    for (let j = i - cfg.window + 1; j <= i; j++) if (at(values, j) > hi) hi = at(values, j);
    return hi - cfg.dropPp;
  });
}

/** ALWAYS-ON drawdown-leg AMBER flags aligned to `observations` — the close below the cut above AND
 *  the short leg moved ≥ `gateBp` bp in EITHER direction over `gateWindow` obs (the shared gate walk,
 *  run direction-agnostically). Independent of the post-inversion rung's arming by construction, and
 *  AMBER-only: it is fed to `withPostInversionFloor` as `amberFires`, which no escalation reads. */
export function drawdownLegSeries(
  observations: Observation[],
  shortLeg: Observation[] | undefined,
  cfg: DrawdownLeg,
): boolean[] {
  const values = observations.map((o) => o.value);
  const cuts = drawdownCutSeries(values, cfg);
  const gate = steepenerEscalationSeries(
    observations,
    shortLeg,
    { shortLegWindow: cfg.gateWindow, shortLegDropBp: cfg.gateBp },
    "either",
  );
  return values.map((v, i) => {
    const c = at(cuts, i);
    return c !== null && v < c && at(gate, i);
  });
}

/** GREEN→AMBER where the rung fires at obs `k + baseOffset`; a firing day that is ALSO
 *  bull-steepening escalates to RED (GREEN/AMBER → RED; RED stays RED). `amberFires` is the
 *  always-on drawdown leg: it can only lift GREEN→AMBER, and NO escalation applies to it. */
function withPostInversionFloor(
  rawStates: State[],
  fires: boolean[],
  escalates: boolean[],
  baseOffset: number,
  amberFires?: boolean[],
): State[] {
  return rawStates.map((s, k) => {
    const i = k + baseOffset;
    // `escalates` is read ONLY against the rung's own `fires` — an escalating day on which the
    // AMBER-only drawdown leg is the sole firer must never reach RED (ruling 2026-08-30).
    if (fires[i] && escalates[i]) return "RED";
    return s === "GREEN" && (fires[i] || amberFires?.[i] === true) ? "AMBER" : s;
  });
}

/**
 * SMOOTHED-LEVEL family (R8) — scored against a trailing MEAN of the feed rather than the latest
 * close. A `postInversionCooldown.levelCuts` carrier scores the mean-space rung (armed percentile
 * pair + velocity leg, branch below); a cfg-less id scores its registry `thresholds` level pair via
 * the same `fixedLevelState` every fixed-band id uses, so the `>`/`<` convention and the
 * `direction` flip are shared and not re-derived here.
 *
 * The emitted `value` IS the mean, so the persisted level, the drawn primary line and the scored
 * ribbon are one series by construction. `window` comes from `SMOOTHED_LEVEL_OF`.
 */
export function smoothedLevelReadingSeries(
  indicator: Indicator,
  observations: Observation[],
  window: number,
  shortLeg?: Observation[],
  redWindow?: number,
): Reading[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`[${indicator.id}] smoothed-level window must be a positive integer, got ${window}`);
  }
  if (redWindow !== undefined && (!Number.isInteger(redWindow) || redWindow < window)) {
    throw new Error(`[${indicator.id}] smoothed-level redWindow must be an integer ≥ window, got ${redWindow}`);
  }
  const values = observations.map((o) => o.value);
  const dates = observations.map((o) => o.date);
  const means: number[] = [];
  const rawStates: State[] = [];
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = i - window + 1; k <= i; k++) sum += at(values, k);
    const mean = sum / window;
    means.push(mean);
    rawStates.push(fixedLevelState(indicator, mean));
  }
  // `buildReadings` indexes `values` from `baseOffset`, so hand it a FULL-LENGTH array with the
  // means in their own date slots — a bare `means` array would be off by `window - 1`. The prefix is
  // the FIRST mean repeated, never the raw closes: `delta20` reads `values[i - 20]`, which lands in
  // the prefix for the leading rows, and a raw close there would emit a mean-minus-close hybrid.
  // Repeating `means[0]` keeps deltas in mean space, but rows k=1..20 emit `means[k] − means[0]` — a
  // 1-to-20-obs change under a 20-obs label (understates; the oldest 21 backfilled rows only).
  const padded = [...(new Array<number>(window - 1).fill(means[0] ?? 0)), ...means];
  const cfg = indicator.postInversionCooldown;
  if (cfg?.levelCuts) {
    // MEAN-SPACE rung (R8): the armed expanding-percentile pair over the MEANS supersedes the
    // registry level pair (`fixedLevelState` above is inert — no level thresholds on the carrier),
    // OR'd (worst-of) with the velocity leg on Δ(velocityWindow) of the mean. Steepener escalation
    // stays on the RAW short leg and escalates a level-firing armed day to RED.
    const meanDates = dates.slice(window - 1);
    const { amber, red } = meanLevelCutSeries(means, meanDates, cfg);
    const { amberVelocity, redVelocity } = indicator.thresholds;
    const escalates = steepenerEscalationSeries(observations, shortLeg, cfg);
    const scored = means.map((mean, k): State => {
      const i = k + window - 1;
      // Level leg — same `direction` flip as `fixedLevelState`, against the armed per-day cuts.
      const cutFired = (b: number | null | undefined): boolean =>
        b !== null && b !== undefined && (indicator.direction === "LOW" ? mean < b : mean > b);
      const levelState: State = cutFired(red[k]) ? "RED" : cutFired(amber[k]) ? "AMBER" : "GREEN";
      // Velocity leg — the SAME padded-array delta expression `buildReadings` persists as
      // `delta20`, sign-flipped for `direction: "LOW"` (a FALLING mean is the danger move).
      const d = velocityDeltaAt(padded, i, indicator);
      const move = indicator.direction === "LOW" ? -d : d;
      const velFired = (b: number | undefined): boolean => b !== undefined && move > b;
      const velState: State = velFired(redVelocity) ? "RED" : velFired(amberVelocity) ? "AMBER" : "GREEN";
      const worst: State =
        levelState === "RED" || velState === "RED" ? "RED"
        : levelState === "AMBER" || velState === "AMBER" ? "AMBER"
        : "GREEN";
      return escalates[i] && levelState !== "GREEN" ? "RED" : worst;
    });
    // Stamp each row's armed mean-space pair (`amber[k]`/`red[k]`, the SAME cuts scored above) under
    // R8's wire keys so `api/series.ts` reads the persisted cut instead of recomputing (Stage 2.2).
    const [amberBand, redBand] = R8_MEAN_CUT_BANDS;
    return buildReadings(indicator, padded, dates, scored, window - 1, true).map((r, k) => {
      const bc = finiteBandCuts([
        [amberBand.key, amber[k]],
        [redBand.key, red[k]],
      ]);
      return bc ? { ...r, bandCuts: bc } : r;
    });
  }
  if (redWindow !== undefined) {
    // TWO-WINDOW level (R1, `SMOOTHED_LEVEL_OF.R1.redWindow`): RED = the `redWindow` mean past
    // `redLevel`; AMBER = the `window` mean past it OR the rung armed/fired over the `window` means
    // (`postInversionCutSeries` in mean space). No steepener escalation, no drawdown leg — by ruling.
    const meanDates = dates.slice(window - 1);
    const rungCut = cfg ? postInversionCutSeries(means, cfg, meanDates) : null;
    const { redLevel } = indicator.thresholds;
    const past = (level: number, b: number | null | undefined): boolean =>
      b !== null && b !== undefined && (indicator.direction === "LOW" ? level < b : level > b);
    const scored = means.map((mean, k): State => {
      const i = k + window - 1;
      if (i + 1 >= redWindow) {
        let sum = 0;
        for (let j = i - redWindow + 1; j <= i; j++) sum += at(values, j);
        if (past(sum / redWindow, redLevel)) return "RED";
      }
      return past(mean, redLevel) || past(mean, rungCut?.[k]) ? "AMBER" : "GREEN";
    });
    // Stamp each row's armed rung cut (`rungCut[k]`, the SAME AMBER cut scored above) under R1's
    // wire key so `api/series.ts` reads the persisted cut instead of recomputing (Stage 2.2). `null`
    // where unarmed/released/warm-up ⇒ no key that row.
    return buildReadings(indicator, padded, dates, scored, window - 1, true).map((r, k) => {
      const bc = finiteBandCuts([[POST_INVERSION_BAND.key, rungCut?.[k]]]);
      return bc ? { ...r, bandCuts: bc } : r;
    });
  }
  // A cfg WITHOUT `levelCuts` inherits the raw-close rung (floor + steepener escalation), fired off
  // the RAW closes (never the means) — the pre-2026-08-13 R8 shape, kept for a cfg-less/raw carrier.
  const cooled = cfg
    ? withPostInversionFloor(
        rawStates,
        postInversionFloorSeries(values, cfg, dates),
        steepenerEscalationSeries(observations, shortLeg, cfg),
        window - 1,
      )
    : rawStates;
  return buildReadings(indicator, padded, dates, cooled, window - 1, true);
}

export function scoreSmoothedLevel(
  indicator: Indicator,
  observations: Observation[],
  window: number,
  shortLeg?: Observation[],
  redWindow?: number,
): Reading {
  // A feed shorter than the RED window would emit a RED-blind reading — fail loud instead.
  const minObs = Math.max(window, redWindow ?? 0) + CONFIRM_CLOSES;
  return latest(
    indicator,
    smoothedLevelReadingSeries(indicator, observations, window, shortLeg, redWindow),
    minObs,
    observations.length,
  );
}

/**
 * Inner-join two daily series on date (both oldest→newest), returning the closes
 * for the dates they share. Different symbols can have different history starts
 * and the odd missing day, so we align rather than assume index parity.
 */
export function alignByDate(
  a: Observation[],
  b: Observation[],
): { dates: string[]; a: number[]; b: number[] } {
  const bByDate = new Map(b.map((o) => [o.date, o.value]));
  const dates: string[] = [];
  const av: number[] = [];
  const bv: number[] = [];
  for (const o of a) {
    const bVal = bByDate.get(o.date);
    if (bVal === undefined) continue;
    dates.push(o.date);
    av.push(o.value);
    bv.push(bVal);
  }
  return { dates, a: av, b: bv };
}

/**
 * Inner-join N daily series on date (each oldest→newest), returning the closes for
 * the dates present in EVERY series — the rule-of-three generalization of
 * `alignByDate` (the FX/dispersion/breadth composites are the 3rd–5th open-coded
 * multi-series joins). `values[k]` is the aligned close vector for series `k`,
 * index-aligned to `dates`. An empty input, or series with no common date, yields
 * empty `dates` (and one empty column per series). `scoreBullSteepener` MAY be
 * refactored onto this later — deliberately left as-is here to avoid a
 * behaviour-adjacent diff.
 */
export function alignByDates(series: Observation[][]): { dates: string[]; values: number[][] } {
  if (series.length === 0) return { dates: [], values: [] };
  const maps = series.map((s) => new Map(s.map((o) => [o.date, o.value])));
  const dates: string[] = [];
  const values: number[][] = series.map(() => []);
  // Drive off the FIRST series' dates (order-preserving, oldest→newest), keeping a
  // date only when EVERY series has it.
  for (const o of at(series, 0)) {
    const row = maps.map((m) => m.get(o.date));
    if (row.some((v) => v === undefined)) continue;
    dates.push(o.date);
    row.forEach((v, k) => at(values, k).push(v!));
  }
  return { dates, values };
}
