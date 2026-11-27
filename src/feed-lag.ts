/**
 * Feed-lag classification — the PURE core.
 *
 * Hoisted out of `scripts/probe-feed-lag.ts` because `api/lab.ts` must not import from `scripts/`
 * and a duplicated threshold in the handler is the two-sources-of-truth defect this wave removes.
 * The probe RE-EXPORTS everything here, so `scripts/probe-feed-lag.test.ts` reaches this file
 * through the probe's module path.
 *
 * WHAT THAT SUITE ACTUALLY COVERS — the hoist of `DEEP_LAG_MULTIPLE`, `MIN_GAPS`, `classify`,
 * `impliedCadenceFor`, `shouldCorrect` and `assertNonVacuous` was verbatim, and the suite passed
 * UNMODIFIED across it, which is the falsifier for THAT HOIST — not for those six symbols' current
 * behaviour: `classify` and `shouldCorrect` each gained an `explicit` arm afterwards (§Stage 4 fork),
 * covered by cases where `explicit` and the strict p90 arm DISAGREE. It did not cover `lagRowFor` (the
 * symbol the hoist actually RESTRUCTURED, out of the probe's loop body), `lagTier`, `LAG_SCAN_LIMIT`
 * or `cadenceIndex`. `lagRowFor` and `lagTier` gained their own cases in that suite afterwards
 * (NO-DATA, the distinct-date gap/p90 build, and all three `lagTier` outcomes); `cadenceIndex` is
 * pinned indirectly through `CADENCE_OF` in `api/lab.test.ts`; `LAG_SCAN_LIMIT` has no value pin.
 *
 * WHAT IT ANSWERS: for EVERY served indicator, is its current age (a) normal publication lag,
 * (b) a MIS-REGISTERED cadence — the registry claims one release rhythm and the feed has always
 * run on another — or (c) genuine DEEP-LAG: a feed whose own historical rhythm it has now broken.
 *
 * The distinction matters because `assessIndicatorFreshness` scores age against the id's RESOLVED
 * cut (`lagCutFor`: a per-indicator `lagAfterDays` where one is registered, else the cadence
 * tier) — a registry number either way, so a row whose cadence AND override both misdescribe the
 * publisher's calendar is still flagged as lagging on a normal week. A rotting feed is genuinely dark and
 * must NOT be silenced by widening a threshold. The two look identical from a single age reading,
 * and are separable only by comparing the feed against its OWN history.
 *
 * CLASSIFICATION (one label per indicator, first match wins):
 *   NO-DATA      the store holds ZERO observations for a served id. The most rotten state there is
 *                — never dropped from the census.
 *   DEEP-LAG          age > RHYTHM × DEEP_LAG_MULTIPLE — broken its expected rhythm. Actionable bug. Which
 *                rhythm depends on whether the registry has ASSERTED one (`isExplicitlyRegistered`):
 *                  · no explicit key (63 of the 78 walked ids) — rhythm is `p90Gap`, the strict,
 *                    registry-INDEPENDENT form. Cost: a feed whose p90 is 1d rots at 3d, inside its
 *                    own cut; intended — the claim is the feed against itself, the registry row may
 *                    be wrong.
 *                  · explicit `cadence` or `lagAfterDays` — rhythm is
 *                    `max(p90Gap, LAG_THRESHOLDS[registered])`. See the ⚠ block below: this is the
 *                    ONE place the registry bounds rottability, it floors at the cadence TIER and not
 *                    at the id's resolved cut, and it is scoped to ids the registry asserted a rhythm
 *                    for.
 *                Either way this arm is evaluated BEFORE the FRESH arm — letting `age <= cut → FRESH`
 *                win first would make every coarsely-registered feed unrottable, explicit or not.
 *   MISCADENCED  age ≤ p90Gap (normal for THIS feed) but age > its resolved cut ⇒ the row is
 *                wrong, not the feed. Candidate registry correction; `impliedCadence` names the fix.
 *   LATE         age > cut and age > p90Gap but below the DEEP-LAG multiple — genuinely behind, not
 *                yet dark.
 *   FRESH        age ≤ cut (and within the DEEP-LAG multiple of its own rhythm). Nothing owed.
 *
 * ⚠ `cut` is the id's RESOLVED lag cut (`lagCutFor`, ladder.ts) — a per-indicator
 * `lagAfterDays` where one is registered, else the cadence tier (E7 Stage 3.6, ruled R4). It is NOT
 * `LAG_THRESHOLDS[registered]`: that split made a holiday-slipped H.10 week read `LATE` on the /lab
 * board while the notify line correctly stayed quiet, contradicting E7 §Stage 3.2. The retracted
 * earlier guidance on the LATE row ("watch, do not re-cadence") assumed the census's observation-gap
 * statistic could see release cadence — it cannot; see `docs/reference.md` §[arch] 9. Cross-file design invariants.
 * Re-cadencing a leg whose PUBLISHED
 * schedule is slower than its registration is a correction, not a silencing; the principle that
 * survives is R1 — a cut comes from the publisher's calendar, never from the age we observed.
 *
 * ⚠ REGISTRY-INDEPENDENCE IS NOW SCOPED, NOT ABSOLUTE (E7 §Stage 4 fork — RULED). This file used to
 * claim the DEEP-LAG arm never reads `cut`, so widening a threshold could never be how a rotting feed goes
 * quiet (§I8.3). That claim was built on `p90Gap` describing the feed's RELEASE rhythm — and it does
 * not: it measures OBSERVATION spacing, and H.10 stamps daily observation dates inside a weekly
 * release. So G1/BRENT (p90Gap 3, weekly tier 9) read DEEP-LAG at 7d on a perfectly healthy 9-day-old
 * row, a false RED on the /lab board. For ids the registry has EXPLICITLY registered the rhythm becomes
 * `max(p90Gap, LAG_THRESHOLDS[registered])`: they rot at `2 × tier` instead of `2 × p90Gap`, still
 * rot when genuinely dark, and are unmoved when p90Gap already exceeds the tier. The bound is only
 * defensible because R1 makes the cadence row come from the publisher's calendar rather than from
 * observed age — a corrected cadence is a correction, not a silencing. For every id with no explicit
 * key the strict form stands unchanged; that asymmetry is the point. Do NOT re-generalize either half.
 *
 * ⚠ THE FLOOR IS THE TIER, NOT THE RESOLVED CUT (E7 §Stage 4.7-R2 — RULED; it re-based the 4.6 form).
 * A per-indicator `lagAfterDays` mixes release SPACING with publication LAG, and only spacing bounds
 * rottability — see `deepLagRhythm`'s docblock for EBP, the specimen that made the difference 140d vs 80d.
 * The property this buys back: widening a single feed's `lagAfterDays` can no longer raise its rot
 * bar at all. Only `LAG_THRESHOLDS` can, and that is a four-value table, not a per-feed knob.
 *
 * `shouldCorrect` is silenced entirely for those same ids, for the same reason: a correction derived
 * from observation gaps would tell the next reader to revert a registration the publisher's schedule
 * justifies (it printed `F9/F11/G1/BRENT/FXH weekly → daily` before this rung).
 *
 * The TIER ladder is still tier-based on purpose: `impliedCadenceFor` / `shouldCorrect` answer "which
 * cadence row would the data imply?", a question about release SPACING buckets, not about cuts — so
 * since 2026-08-03 it reads `AMBITION_THRESHOLDS`, NOT the alarm table (which absorbed the T+1 weekend
 * publication lag that day and can no longer answer a pure-spacing question). See `impliedCadenceFor`.
 */
import type { Cadence, Indicator } from "./domain-types.js";
import { AMBITION_THRESHOLDS, LAG_THRESHOLDS, assessIndicatorFreshness, lagCutFor } from "./ladder.js";
import { todayOnFeedCalendar } from "./dates.js";
import {
  containmentGrid,
  slotAge,
  type FeedObservations,
  type PublicationCalendar,
} from "./publication-calendar.js";
import { ALL_INDICATORS } from "./registry.js";
import { COMPOSITE_COMPONENTS } from "./registry-composite.js";
import { POSTGREST_MAX_ROWS } from "./postgrest-limits.js";
import { slotLag } from "./release-delay.js";
import { isSlotExcused } from "./market-closures.js";
import { isProvisional } from "./intraday.js";
// TYPE-ONLY, and it must stay that way: `store.ts` sits in a value cluster that reaches this file
// (`store → alert-band → t1dial → danger-engine → feed-lag`), so a VALUE import here closes a real
// runtime cycle — `src/import-cycle.test.ts` reds on it. That is why `POSTGREST_MAX_ROWS` is read
// from the `postgrest-limits.ts` leaf above rather than from `store.js`.
import type { SeriesPoint, ReadStore } from "./store.js";
// TYPE-ONLY, and it must stay that way: `danger-engine.ts` value-imports `lagTier` from this file, so
// a value import here would close a real runtime cycle. `import type` is erased at compile time.
import type { MemberFreshness } from "./danger-engine.js";

/** Age beyond which a feed has broken its OWN rhythm badly enough to read as dark, not late.
 *  2× its demonstrated p90 spacing: one missed publication is LATE, two is a pattern. Sanity-bound
 *  (`impag` Rules — a one-sided-verifiable constant): too LOW cries rot on any holiday week, too
 *  HIGH lets a dead feed read as merely late. Pinned in `probe-feed-lag.test.ts`. */
export const DEEP_LAG_MULTIPLE = 2;

/** Below this many observed gaps, `p90Gap` is noise, not an expectation (guard b). */
export const MIN_GAPS = 8;

export type Label = "NO-DATA" | "DEEP-LAG" | "MISCADENCED" | "LAG" | "FRESH" | "UNKNOWN";

/** Observations per indicator to scan when measuring a feed's OWN rhythm — RE-EXPORTED verbatim
 *  from the registry-free `publication-calendar.ts` leaf, where the literal lives so the run-path
 *  stamp (`stampFreshness`, scorers-core.ts) can share it without importing this file's registry
 *  cluster. Shared by `scripts/probe-feed-lag.ts` and `/lab`'s stage-2 deep read, so the two measure
 *  the same window (§I9.6 item 1). */
export { LAG_SCAN_LIMIT } from "./publication-calendar.js";
import { LAG_SCAN_LIMIT } from "./publication-calendar.js";
import { isoDay } from "./dates.js";

/**
 * One served entry for a feed `/lab` classified as marked (§I9.6 item 4) — the classification plus
 * the numbers that justify it, so the reader can say "9d against a 6d bar" rather than an
 * unfalsifiable "lag". Rendered by `/lab`'s ledger footnote (`feedLagFootHtml`, `public/lab.js`,
 * §I9.8 J4) — nullable `age`/`deepLagBar`/`p90Gap` print `—` there, never `0d`.
 *
 * `age`/`p90Gap`/`deepLagBar` are NULLABLE on purpose: `NO-DATA` has no newest observation to age from, and the
 * `?s=lag:<id>` debug knob ASSERTS a classification rather than measuring one. A fabricated 0
 * there would be exactly the substitute-a-value-for-an-absence defect this wave removes.
 */
export interface FeedLagNote {
  id: string;
  label: Label;
  age: number | null;
  p90Gap: number | null;
  /** The age the DEEP-LAG arm actually tested this feed against — `deepLagRhythm × DEEP_LAG_MULTIPLE`, i.e.
   *  `2 × p90Gap` for an unregistered id and `2 × max(p90Gap, LAG_THRESHOLDS[registered])` for an
   *  explicitly registered one (E7 §Stage 4.7-R2). Served so the footnote can name the bar that was
   *  applied instead of always
   *  saying "own p90", which is false for the explicit arm. Null exactly when `p90Gap` is: nothing
   *  was measured (`NO-DATA`, or a `?s=lag:` knob assertion). */
  deepLagBar: number | null;
  /** The resolved lag cut the FRESH arm scored `age` against (`lagCutFor`) — the bar a `LAG` label crossed.
   *  Null only for a `?s=lag:` knob assertion. */
  lagCut: number | null;
  registered: Cadence;
}

/**
 * The two-tier classification a label carries (§I8/§I9.6): `"deep"` = the feed broke its own rhythm,
 * or never reported at all ("lagging too much to react to a crash in time"), `"soft"` = behind, not
 * dark, `null` = nothing marked. FRESH and UNKNOWN both classify as nothing: UNKNOWN means the
 * window is too short to have an expectation, and inventing a mark from that would be exactly the
 * substitute-a-value-for-an-absence defect this wave removes.
 *
 * The SINGLE source of the two-tier rule — today `CellObserved.deepLag` (the engine) and the served
 * `feedLag` footnote payload both derive from it rather than re-testing labels. The FE half now
 * paints off the same two tiers: `lagMark`/`legLagMark` (`public/cell-observed.js`) emit
 * `sig-lag-deep` / `sig-lag-soft` with the `◌` (cell) and `⌁` (leg) glyphs, styled in `public/lab.html`'s
 * scoped sheet.
 */
export function lagTier(label: Label): "deep" | "soft" | null {
  if (label === "DEEP-LAG" || label === "NO-DATA") return "deep";
  if (label === "MISCADENCED" || label === "LAG") return "soft";
  return null;
}

export interface Row {
  id: string;
  registered: Cadence;
  /** The RESOLVED cut this row was classified against (`lagCutFor`) — per-indicator
   *  `lagAfterDays` where registered, else the cadence tier. Renamed from `tierCut` at E7 Stage
   *  3.6 precisely because it is no longer the tier. */
  cut: number;
  /** Did the registry ASSERT this id's rhythm (`isExplicitlyRegistered`)? Gates the DEEP-LAG arm's
   *  `max(p90Gap, LAG_THRESHOLDS[registered])` rhythm and silences `shouldCorrect` — E7 §Stage 4
   *  fork, floor re-based at §Stage 4.7-R2. */
  explicit: boolean;
  age: number;
  newest: string;
  gaps: number;
  medianGap: number;
  p90Gap: number;
  impliedCadence: Cadence;
  label: Label;
}

const CADENCE_TIERS: readonly Cadence[] = ["daily", "weekly", "monthly", "quarterly"];

/**
 * The FINEST tier whose threshold still covers `gap` — the cadence the DATA implies.
 *
 * ⚠ Reads `AMBITION_THRESHOLDS`, NOT `LAG_THRESHOLDS` (2026-08-03). It asks "which cadence
 * BUCKET does this observation spacing fall in?", which is a question about release SPACING alone.
 * The alarm table stopped being able to answer it when `daily` moved 3 → 4 to absorb the weekend
 * publication lag of a T+1 feed: that 4 is spacing PLUS lag, so reading it here reclassified a 4d
 * gap from `weekly` to `daily` and would have quietly moved `shouldCorrect`'s registry-correction
 * advice — a knock-on with nothing to do with the false-lag that rung was fixing. The ambition
 * table still holds the pure spacing buckets, so this stays byte-unchanged across that move.
 *
 * The DEEP-LAG arm deliberately does NOT follow: `deepLagRhythm` floors at `LAG_THRESHOLDS[registered]`
 * because a deep-lag bar SHOULD widen with the real tolerance. Do not unify the two.
 */
export function impliedCadenceFor(gap: number): Cadence {
  for (const tier of CADENCE_TIERS) if (gap <= AMBITION_THRESHOLDS[tier]) return tier;
  return "quarterly";
}

const tierIndex = (c: Cadence): number => CADENCE_TIERS.indexOf(c);

/**
 * Should this row be published as a CANDIDATE REGISTRY CORRECTION?
 *
 * FIRST: nothing at all for an EXPLICITLY registered id (E7 §Stage 4 fork — RULED). That gate is
 * checked before the fining/coarsening split below, and it OVERTURNS the "a fining correction is
 * always safe" rule this docblock used to open with: the registry asserted those rhythms from the
 * publisher's calendar, and a fining derived from observation gaps advises reverting them.
 *
 * For every OTHER id the split still holds. A FINING correction (implied tighter than registered)
 * is safe: it narrows the cut, so at worst it cries lag a little early. A COARSENING one widens
 * the cut and is exactly what §I8.3 forbids — widening a threshold must never be the way a rotting
 * feed goes quiet. `p90Gap` alone
 * has ZERO margin for that call: a daily feed whose p90 stretches to 4d over one holiday week
 * prints `daily → weekly` and would widen its cut 3 → 9. So a coarsening also requires the
 * MEDIAN to have left the finer tier — one bad week moves the p90, not the median.
 */
export function shouldCorrect(r: Pick<Row, "registered" | "impliedCadence" | "medianGap" | "label" | "explicit">): boolean {
  if (r.label === "UNKNOWN" || r.label === "NO-DATA") return false;
  // The registry has ASSERTED this feed's rhythm from the publisher's calendar (R1). Observation
  // gaps cannot see a release grid, so a correction derived from them can only ever advise undoing
  // that assertion — which is exactly what it did for F9/F11/G1/BRENT/FXH (E7 §Stage 4 fork).
  if (r.explicit) return false;
  if (r.impliedCadence === r.registered) return false;
  const coarsening = tierIndex(r.impliedCadence) > tierIndex(r.registered);
  if (!coarsening) return true;
  return tierIndex(impliedCadenceFor(r.medianGap)) > tierIndex(r.registered);
}

/**
 * The rhythm the DEEP-LAG multiple is taken against — `p90Gap` for an id the registry says nothing about,
 * `max(p90Gap, LAG_THRESHOLDS[registered])` for one it has explicitly registered (E7 §Stage 4.7-R2,
 * which re-based this floor off the RESOLVED cut). The `max` is load-bearing in BOTH directions: an
 * explicit feed whose observed p90 already exceeds its tier keeps the strict form, so this can only
 * ever RAISE the deep-lag bar, never lower it.
 *
 * ⚠ The floor is the CADENCE TIER, deliberately NOT the resolved cut (`lagCutFor`). A per-indicator
 * `lagAfterDays` folds together two different quantities — release SPACING and publication LAG — and
 * only the first bounds rottability. EBP is the specimen: monthly obs stamped the 1st and published
 * mid-following month reach ~55d by construction, so its cut is 70 while its release grid is the
 * `p90Gap` of 31 it already demonstrates. Flooring at the cut gave it a 140d bar — four and a half
 * months of darkness. Flooring at the tier gives 80d and closes 4.3-D2 just as well (G1/BRENT:
 * `2 × max(3, 9) = 18` against a 9d age). The consequence worth keeping: a per-id `lagAfterDays`
 * widening can no longer raise this bar AT ALL — only a change to `LAG_THRESHOLDS` can.
 */
export function deepLagRhythm(args: { registered: Cadence; p90Gap: number; explicit: boolean }): number {
  return args.explicit ? Math.max(args.p90Gap, LAG_THRESHOLDS[args.registered]) : args.p90Gap;
}

/**
 * The ladder, pure. DEEP-LAG is tested FIRST, against `deepLagRhythm` — see the CLASSIFICATION block. Letting
 * `age <= cut → FRESH` win first would make EVERY coarsely-registered feed unrottable; the explicit
 * arm of `deepLagRhythm` bounds that deliberately and only for ids whose registered cadence is a
 * publisher's calendar.
 *
 * ⚠ `cut` and `registered` are BOTH read, and they are not interchangeable: `cut` is the resolved
 * lag cut the FRESH arm scores against, `registered` feeds the DEEP-LAG arm's tier floor. An id where
 * they disagree (`lagAfterDays` present) classifies differently under each — which is exactly the
 * discriminating case `probe-feed-lag.test.ts` pins (E7 §Stage 4.7-R2).
 */
export function classify(args: {
  gaps: number;
  age: number;
  cut: number;
  registered: Cadence;
  p90Gap: number;
  explicit: boolean;
}): Label {
  if (args.gaps < MIN_GAPS) return "UNKNOWN";
  if (args.age > deepLagRhythm(args) * DEEP_LAG_MULTIPLE) return "DEEP-LAG";
  if (args.age <= args.cut) return "FRESH";
  if (args.age <= args.p90Gap) return "MISCADENCED";
  return "LAG";
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx] ?? 0;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function isoDaysBefore(iso: string, days: number): string {
  return isoDay(new Date(Date.parse(iso) - days * 86_400_000));
}

/**
 * One id's full lag row from its stored observation dates — the gap math + `classify`, hoisted out
 * of `scripts/probe-feed-lag.ts`'s loop body (§I9.6 item 1) so `/lab` and the probe are ONE
 * implementation rather than two that can drift on the p90 convention.
 *
 * ⚠ This symbol was RESTRUCTURED by that hoist, not moved verbatim, so the probe suite passing
 * unmodified proved nothing about it. Its own cases (NO-DATA; the distinct-date gap/p90 build) were
 * added to `scripts/probe-feed-lag.test.ts` afterwards and are what covers it.
 *
 * `dates` may arrive in any order and may repeat: it is de-duplicated and sorted here, because the
 * gaps that define a feed's rhythm are between DISTINCT observation dates (a re-published day is
 * not a new release). An EMPTY list is `NO-DATA` with `age = Infinity` — a served id the store has
 * never heard of is the most rotten state there is and is never dropped from the census.
 */
export function lagRowFor(args: {
  id: string;
  registered: Cadence;
  /** The id's RESOLVED lag cut (`lagCutFor`). REQUIRED — no tier fallback lives here, so a
   *  new call site cannot silently classify against `LAG_THRESHOLDS` while the notify line uses the
   *  override (E7 Stage 3.6). Callers that hold only a cadence pass `lagCutFor({ cadence })`. */
  cut: number;
  /** Whether the registry ASSERTED this id's rhythm (`explicitRegistrationIndex` /
   *  `isExplicitlyRegistered`). REQUIRED for the same reason `cut` is (E7 Stage 3.6): a new call site
   *  must decide, never silently inherit the strict p90 arm while `/lab` and the probe use the other. */
  explicit: boolean;
  dates: readonly string[];
  today: string;
}): Row {
  const { id, registered, cut, explicit, today } = args;
  const dates = [...new Set(args.dates)].sort();
  if (dates.length === 0) {
    return {
      id,
      registered,
      cut,
      explicit,
      age: Number.POSITIVE_INFINITY,
      newest: "-",
      gaps: 0,
      medianGap: 0,
      p90Gap: 0,
      impliedCadence: registered,
      label: "NO-DATA",
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1]!, dates[i]!));
  gaps.sort((a, b) => a - b);
  const newest = dates[dates.length - 1]!;
  const age = daysBetween(newest, today);
  // ⚠ **`medianGap`/`p90Gap` measure OBSERVATION spacing and are BLIND to RELEASE cadence** — so
  // a cadence claim built on them was REFUTED (`weekly` is correct).
  const p90Gap = quantile(gaps, 0.9);
  const medianGap = quantile(gaps, 0.5);
  return {
    id,
    registered,
    cut,
    explicit,
    age,
    newest,
    gaps: gaps.length,
    medianGap,
    p90Gap,
    impliedCadence: impliedCadenceFor(p90Gap),
    label: classify({ gaps: gaps.length, age, cut, registered, p90Gap, explicit }),
  };
}

/**
 * Guards (a1)/(a2) and (c), plus (b)'s "nothing classifiable" arm. Throws — the caller exits non-zero.
 * Split out of the probe's `main` so `probe-feed-lag.test.ts` can demonstrate each one FIRING.
 *
 * ⚠ GUARD (a) ASSERTS A CAPABILITY, NOT AN OUTCOME (E7 §Stage 4.7-R1 — RULED). It used to demand a
 * MIXED census — some FRESH, some not — on the theory that a uniform census makes classification
 * vacuous. That inverted the moment the system got healthy: once E7 removed the three FALSE ROTs, every
 * classified prod feed read FRESH and the guard threw on the exact steady state this rung was built to
 * produce. Read plainly, its green had been load-bearing on the defect sitting beside it. The
 * all-lagging half survives — that really is a wrong-store symptom (the dev DB, which has no cron) — but
 * the all-fresh half is replaced by a perturbation check on the classifier itself.
 *
 * The general rule this now encodes, for the next guard anyone writes here: assert what the CODE can
 * do, never what the DATA happened to look like.
 */
export function assertNonVacuous(rows: readonly Row[]): void {
  const classified = rows.filter((r) => r.label !== "UNKNOWN" && r.label !== "NO-DATA");
  if (classified.length === 0) throw new Error("guard (b): no indicator cleared MIN_GAPS - nothing classifiable");

  const fresh = classified.filter((r) => r.label === "FRESH").length;
  if (fresh === 0)
    throw new Error(
      `guard (a1): census is all-lagging (0/${classified.length} FRESH). A store where nothing is current ` +
        `makes every classification vacuous - run with --env=prod (I6.1/I7.1).`,
    );

  // guard (a2) — CAPABILITY. Perturb each row's age and require the label to MOVE. What the DEEP-LAG half
  // actually asserts is that the bar is FINITE: `classify` recomputes `deepLagRhythm(row) * DEEP_LAG_MULTIPLE`
  // from the same fields, so `age > bar` reduces to `bar + 1 > bar` and only a non-finite bar (an
  // Infinity/NaN rhythm) can red it — that it does on a perfectly healthy all-FRESH prod, which is
  // precisely what the outcome form could not do. It does NOT cover a DEEP-LAG arm reordered below FRESH:
  // the probe age `bar + 1` exceeds every real id's cut, so the FRESH arm cannot win at that age. Arm
  // ORDER is covered by `classify`'s own tests in `probe-feed-lag.test.ts`, not here. The age-0 half is
  // near-trivial by construction (`0 <= cut` for any non-negative cut) and pins only that DEEP-LAG does not
  // swallow a zero-age row — it is NOT independent coverage.
  for (const r of classified) {
    const bar = deepLagRhythm(r) * DEEP_LAG_MULTIPLE;
    const rotted = classify({ ...r, age: bar + 1 });
    if (rotted !== "DEEP-LAG")
      throw new Error(
        `guard (a2): classifier cannot reach DEEP-LAG for ${r.id} - age ${bar + 1}d against a ${bar}d bar ` +
          `classified ${rotted}. The census may be healthy, but the DEEP-LAG arm is not discriminating.`,
      );
    const zeroed = classify({ ...r, age: 0 });
    if (zeroed !== "FRESH")
      throw new Error(
        `guard (a2): classifier cannot reach FRESH for ${r.id} - a 0d age classified ${zeroed} against ` +
          `a ${r.cut}d cut.`,
      );
  }

  if (!classified.some((r) => r.registered !== "daily"))
    throw new Error("guard (c): no CLASSIFIED non-default registry cadence - the mis-cadence arm cannot disagree");
}

/** Every id `verdictHoldLegs` / `/api/status` / `/lab`'s freshness stamp score: the served registry PLUS
 *  the composite components, which live OUTSIDE `ALL_INDICATORS` (`COMPOSITE_COMPONENTS` is not
 *  spread into it) and were silently defaulted by the first `CADENCE_OF` (§I7.2 — the bug the
 *  probe caught: the `CMP_FXH_*` ids fell through to the registry-less default and lost their
 *  per-source registration — their `cadence: daily`, 2026-08-10; the `lagAfterDays` override retired slice-3).
 *  ONE table, shared by the probe and the handler — a second copy is the drift this hoist removes. */
export function cadenceIndex(): Map<string, Cadence> {
  return new Map([...freshnessScoredIndicators()].map(([id, ind]) => [id, ind.cadence ?? "daily"]));
}

/** The lag CUT for every id `cadenceIndex` covers — `lagAfterDays` where the id carries one
 *  (E7), else its cadence tier — resolved through the shared `lagCutFor` (ladder.ts) over the SAME
 *  registry walk, so the /lab board's lag flag and the notify path's `verdictHoldLegs` cannot disagree.
 *  Pinned id-for-id against `lagCutFor` in `api/lab.test.ts`. */
export function lagCutIndex(): Map<string, number> {
  return new Map([...freshnessScoredIndicators()].map(([id, ind]) => [id, lagCutFor(ind)]));
}

/**
 * Has the registry ASSERTED this id's release rhythm, rather than falling through to the `daily`
 * default? A `cadence` key or a per-indicator `lagAfterDays` both count — either one is a claim
 * about the publisher's calendar (R1), and it is that claim, not the observed gaps, the DEEP-LAG arm and
 * `shouldCorrect` defer to for these ids (E7 §Stage 4 fork — RULED).
 *
 * 63 of the 78 ids `explicitRegistrationIndex` scores carry NEITHER and are untouched by the
 * explicit arm; the 15 that do are pinned by `EXPLICIT_OF` in `api/lab.test.ts` (both figures
 * re-measured 2026-08-15 off `explicitRegistrationIndex()`).
 *
 * ⚠ This split has now rotted TWICE ("58 of the 69", then "63 of the 75"), and the second time the
 * "12" read correct only by coincidence — it was written while the true count was 11. Only the
 * `api/lab.test.ts` pin is load-bearing; this paragraph is prose with no guard, so re-measure it
 * from `explicitRegistrationIndex()` whenever a registry row gains or loses `cadence`/`lagAfterDays`
 * rather than trusting the date stamped on it.
 */
export function isExplicitlyRegistered(ind: Pick<Indicator, "cadence" | "lagAfterDays">): boolean {
  return ind.cadence !== undefined || ind.lagAfterDays !== undefined;
}

/** The explicit-registration flag for every id `cadenceIndex` covers, off the SAME registry walk —
 *  so `/lab`'s board and the probe cannot disagree about which arm an id was classified under. */
export function explicitRegistrationIndex(): Map<string, boolean> {
  return new Map([...freshnessScoredIndicators()].map(([id, ind]) => [id, isExplicitlyRegistered(ind)]));
}

/** id → the publication-calendar timezone its "today" is resolved on (`feedTimeZone`), off the SAME
 *  registry walk. `undefined` where the id registers none, which is what {@link todayOnFeedCalendar}
 *  already reads as {@link FEED_CALENDAR_TZ} — so the map stores the registry's answer verbatim
 *  rather than baking the default in, and an id that gains a `feedTimeZone` needs no change here.
 *  Exists so `/lab` resolves "today" per feed exactly as `/api/status` does; a single UTC date across
 *  all ids is the phantom-stale-day bug on that constant's docblock. */
export function feedTimeZoneIndex(): Map<string, string | undefined> {
  return new Map([...freshnessScoredIndicators()].map(([id, ind]) => [id, ind.feedTimeZone]));
}

/** The ONE walk all three indices above project from: served registry + composite components. */
function freshnessScoredIndicators(): Map<string, Indicator> {
  const m = new Map<string, Indicator>();
  for (const i of ALL_INDICATORS) m.set(i.id, i);
  for (const comps of Object.values(COMPOSITE_COMPONENTS)) for (const c of comps) m.set(c.id, c.indicator);
  return m;
}

/** id → the cadence its freshness is scored against (OQ-5 Stage 5.2 / §I7.2). Built by the SHARED
 *  `cadenceIndex()`, i.e. over `ALL_INDICATORS` **plus** `COMPOSITE_COMPONENTS`:
 *  the composite component ids (`CMP_FXH_*`) carry `cadence: daily` (the `=X` pairs,
 *  2026-08-10; their `lagAfterDays` override retired slice-3) via `componentIndicator` but do NOT appear in `ALL_INDICATORS`, so a
 *  registry-only table silently drops the override and scores them on the bare tier cut. Pinned by
 *  api/lab.test.ts ("CADENCE_OF covers the composite components"). Exported for that pin only. */
export const CADENCE_OF = cadenceIndex();

/** id → the lag CUT in calendar days its freshness stamp is scored against (E7). Companion to
 *  `CADENCE_OF`, built by `lagCutIndex()` over the SAME registry walk and resolved by the shared
 *  `lagCutFor`, so an id carrying a per-indicator `lagAfterDays` is scored identically here and
 *  on the notify path (`verdictHoldLegs`) — the board and the flag can never disagree. Pinned id-for-id
 *  against `lagCutFor` in api/lab.test.ts. */
export const LAG_CUT_OF = lagCutIndex();

/** id → did the registry ASSERT its release rhythm (a `cadence` key or a `lagAfterDays`)? Third
 *  companion off the SAME registry walk. Gates the DEEP-LAG arm's `max(p90Gap, LAG_THRESHOLDS[registered])`
 *  rhythm — the cadence TIER, not the id's resolved cut (E7 §Stage 4.7-R2) — and silences
 *  `shouldCorrect` — E7 §Stage 4 fork; without it the board paints a false RED on G1/BRENT. */
export const EXPLICIT_OF = explicitRegistrationIndex();

/** id → its `feedTimeZone` (undefined ⇒ the `FEED_CALENDAR_TZ` default), fourth companion off the
 *  SAME registry walk. `freshnessFrom` resolves "today" through it per id, so `/lab`'s board scores
 *  age on the publisher's calendar exactly as `/api/status` does — a request served in the window
 *  where UTC has rolled over and the US source has not reads every daily feed a phantom day old. */
export const FEED_TZ_OF = feedTimeZoneIndex();

/** Every composite-component id (`COMPOSITE_COMPONENTS`) — a leg shares its PARENT's fetch, so it is
 *  NOT an independent source and does not count toward {@link MIN_CALENDAR_SOURCES} (R14.3). This is
 *  the `independent` flag `freshnessFrom` stamps onto each daily feed it hands `containmentGrid`, and
 *  the derivation, never a hand-typed count. (The cohort/tz-key machinery — `CALENDAR_COHORT_OF`,
 *  `calendarCohortOf`, `CALENDAR_COHORTS`, `CALENDAR_REPS_PER_COHORT`, `CohortSources` — was retired
 *  at R14.4: containment self-partitions each feed's calendar off its own printed days, so no tz key
 *  pools sources any more. `FEED_TZ_OF` STAYS — `feedTimeZone` keeps its "today" role.) */
export function compositeComponentLegIds(): Set<string> {
  const legs = new Set<string>();
  for (const comps of Object.values(COMPOSITE_COMPONENTS)) for (const c of comps) legs.add(c.id);
  return legs;
}

/** composite-leg id → its PARENT composite id (each `COMPOSITE_COMPONENTS` KEY is the parent id).
 *  R14.3: a leg shares its parent's fetch, so it is scored against the parent's publication calendar
 *  ({@link freshnessFrom}); a leg alone has 0 independent sources and throws below
 *  {@link MIN_CALENDAR_SOURCES}. Parent ungriddable ⇒ leg stays ungriddable, no fabricated fallback. */
export function compositeLegParentIndex(): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [parentId, comps] of Object.entries(COMPOSITE_COMPONENTS)) for (const c of comps) parents.set(c.id, parentId);
  return parents;
}

/** Ids per stage-2 deep read: floor(POSTGREST_MAX_ROWS / LAG_SCAN_LIMIT), the same per-RPC chunk
 *  `SupabaseStore.getSeriesBulk` cuts itself; the chunks run in parallel. See `freshnessFrom`. */
export const LAG_CHUNK_IDS = Math.floor(POSTGREST_MAX_ROWS / LAG_SCAN_LIMIT);

export interface FreshnessStamp {
  /** the per-id stamp `computeField` scores `observed` from (stage 1, plus stage-2 `label`s). */
  freshness: readonly MemberFreshness[];
  /** the marked feeds, for the designed `/lab` footnote (§I9.7, unshipped) — only ids `lagTier`
   *  gives a tier. */
  lag: readonly FeedLagNote[];
  /**
   * id → calendar days between its NEWEST STORED observation and today ON ITS OWN publication
   * calendar — the age the `lag` flag beside it was scored from, so a consumer serving both
   * cannot pair a series verdict with a differently-sourced number.
   *
   * ⚠ A KEY IS ABSENT WHERE THERE IS NO MEASUREMENT TO REPORT — never `0` and never `null`. TWO
   * causes, not one: the store holds zero observations for the id, OR (since 2026-09-10) its
   * publication calendar could not be built, so there is no grid to score a slot age against
   * (`gridOrAbsent`). The two are DISTINCT in `freshness`: a zero-row id is `lag: true` (the worst
   * state), an ungriddable one is `unmeasured: true` with no `lag` key. Either way there is no age to
   * report; a fabricated 0 would read as "fresh today", the substitute-a-value-for-an-absence
   * defect this whole axis exists to kill. Consumers must branch on the miss, not coalesce it.
   *
   * Added for `/api/status`'s per-indicator ages,
   * which moved off the RUN's rows onto this series source.
   *
   * ⚠ SINCE THE SLOT WIRE THIS IS SLOTS for a
   * daily/weekly id and CALENDAR DAYS for monthly/quarterly — read the unit from {@link ageUnit} at
   * the same key; the two maps share their keys exactly (same absent-on-zero-rows rule).
   */
  ageDays: ReadonlyMap<string, number>;
  /** id → the UNIT of its {@link ageDays} entry: `"slots"` for the daily/weekly slot path,
   *  `"days"` for monthly/quarterly. Keyed identically to `ageDays` — absent wherever that is, for
   *  either of its two causes. A consumer serving the age MUST serve this beside it, never a bare
   *  number. */
  ageUnit: ReadonlyMap<string, "slots" | "days">;
  /** id → its lag note's measured `deepLagBar` in the {@link ageUnit} of the same key — a slot id's day
   *  bar recounted as `slotAge(today − bar, today)` on its scoring grid. Keyed only where both exist. */
  deepLagBarInAgeUnit: ReadonlyMap<string, number>;
  /** id → its NEWEST stored row (stage 1), keyed only where one exists — `/status`'s B7 INTRADAY
   *  card overlay reads it, so the overlay costs no second read. Unlike the aging, it KEEPS an
   *  `estimated` head (the overlay serves it as EST). */
  newest: ReadonlyMap<string, SeriesPoint>;
}

/** {@link freshnessFrom}'s STAGE 1 read. Returns the daily/weekly (slot) ids, every id's stage-1
 *  window (prints only for a slot id) and each slot id's UNFILTERED newest row. */
async function readStage1Windows(
  store: ReadStore,
  ids: readonly string[],
): Promise<{ slotIds: string[]; seriesById: Map<string, readonly SeriesPoint[]>; rawHeadById: Map<string, SeriesPoint> }> {
  // STAGE 1 READ SHAPE (R14.4). A daily/weekly id is scored in publication SLOTS against a
  // per-target CONTAINMENT grid, which needs the id's OWN deep date window (not just its newest
  // row) plus every daily feed's window as its candidate peers — so read `LAG_SCAN_LIMIT` deep for
  // every daily/weekly id, chunked at `LAG_CHUNK_IDS` (~83 ids ⇒ a few parallel chunks). Monthly/quarterly ids stay on
  // calendar days and need only their newest row (`limit: 1`). The daily/weekly deep window doubles
  // as stage 2's deep read below — same `LAG_SCAN_LIMIT`, so a slot suspect is never re-fetched.
  const slotIds: string[] = [];
  const dayIds: string[] = [];
  for (const id of ids) {
    const cadence = CADENCE_OF.get(id) ?? "daily";
    (cadence === "daily" || cadence === "weekly" ? slotIds : dayIds).push(id);
  }
  const slotChunks: string[][] = [];
  for (let i = 0; i < slotIds.length; i += LAG_CHUNK_IDS) slotChunks.push(slotIds.slice(i, i + LAG_CHUNK_IDS));
  const [dayShallow, ...slotDeep] = await Promise.all([
    store.getSeriesBulk(dayIds, { limit: 1 }),
    ...slotChunks.map((c) => store.getSeriesBulk(c, { limit: LAG_SCAN_LIMIT })),
  ]);
  // stage-1 rows: the DEEP window for every slot id (reused by stage 2), the newest row for each
  // monthly/quarterly id. `getSeriesBulk` returns oldest→newest, so `.at(-1)` is the newest.
  // Prints only: an `estimated` head (E11) would age a feed outage 0. Estimate ids are all daily/weekly, so the
  // `limit: 1` monthly/quarterly read never meets one.
  const seriesById = new Map<string, readonly SeriesPoint[]>();
  for (const [id, pts] of dayShallow) seriesById.set(id, pts);
  // The UNFILTERED head stays on `newest` below: `/status`'s B7 overlay serves an estimate card as EST (E3).
  const rawHeadById = new Map<string, SeriesPoint>();
  for (const m of slotDeep)
    for (const [id, pts] of m) {
      const head = pts.at(-1);
      if (head !== undefined) rawHeadById.set(id, head);
      seriesById.set(id, pts.filter((p) => p.estimated !== true));
    }
  return { slotIds, seriesById, rawHeadById };
}

/**
 * The freshness stamp `computeField` scores `observed` from — a stage-1 read of every served id
 * (the daily/weekly ids `LAG_SCAN_LIMIT`-deep so each can build its own containment slot grid,
 * R14.4; the monthly/quarterly ids `limit: 1`) (§I9.1).
 *
 * SOURCE = THE SERIES, NOT THE RUN. Age is `today − max(observation date stored for that id)`, so
 * the mark describes THE FEED's true state, which is what §I8 asks the user to notice. The run's own
 * rows (`getReadingsForRun`) are a property of ONE run and §I8.4 measured the two disagreeing on 2 of
 * 9 legs (R6/VT: the latest run wrote 07-17 over a stored 07-24) — reading them would paint
 * false-lag. It also makes `/lab` and `npm run probe:feed-lag` the same measurement.
 *
 * `today`, never `asOf`: a feed's lag is measured against now, not against the vintage of the last run
 * — anchoring on `asOf` would make every feed read fresh on a cron that stopped running.
 *
 * ⚠ AND "TODAY" IS PER FEED, NOT UTC (2026-08-04). The caller passes the CLOCK (`now`), not a date
 * string: this path is served at REQUEST time, so unlike the 22:00 UTC cron it is routinely hit in
 * the window where UTC has rolled over and the US source has not, and one UTC date across all ids
 * reads every daily feed a phantom day old. Each id's date is resolved through `todayOnFeedCalendar`
 * against `FEED_TZ_OF` — the same seam `/api/status` resolves ITS dates through.
 *
 * SINCE `bd5d97f6` `/api/status` IS A CONSUMER OF THIS FUNCTION, not a second implementation: it
 * passes its own one pinned `now` in and takes each served reading's `ageDays`/`lag` from this
 * stamp (§Ruled contract 1). HISTORICAL, and the reason that changed: while `/api/status` aged rows
 * from `getReadingsForRun`, §I8.4 measured the two sources disagreeing on 2 of 9 legs (R6/VT — the
 * latest run had written 07-17 over a stored 07-24, so the run-row age read false-lag). That is a
 * record of why the source moved, NOT a live divergence claim. What remains true per-leg today is
 * only the DEGRADE path: if this call throws, `/api/status` falls back to the run row for BOTH
 * fields of the affected reading (never one field from each) and omits its per-feed pill entirely.
 * Agreement of stage 1 and stage 2 BELOW is by construction — they share `todayOf` and the one
 * pinned `now`.
 *
 * A served id with ZERO stored rows is `lag: true`, not "unknown": the most rotten state there is
 * must never read as calm (that absence-reads-as-calm defect is the whole point of the axis).
 *
 * STAGE 2 — THE LAG CLASSIFICATION (§I9.6 item 2). Stage 1 answers "past its registered cut?".
 * Stage 2 answers "and is that the FEED's fault or the ROW's?", by re-reading the lagging suspects
 * DEEP (`LAG_SCAN_LIMIT` observations) and running `lagRowFor` — the same function
 * `npm run probe:feed-lag` uses, so the dashboard and the instrument cannot disagree. Only labels
 * that `lagTier` tiers (DEEP-LAG/NO-DATA the heavier tier, LATE/MISCADENCED the quiet one) are attached.
 * ⚠ The tiers are
 * SERVED only — the `◌` paint is §I9.7 and is not shipped.
 *
 * ⚠ BOUNDARY, stated honestly: stage 2 runs over the ids stage 1 already called lagging **by their
 * registered cut**. A feed rotting INSIDE a too-coarse cut is therefore invisible here BY
 * CONSTRUCTION — that is exactly the class the `FXH weekly→daily` correction fixed, and exactly
 * what `npm run probe:feed-lag`'s registry-correction arm exists to catch. `/lab` refines a
 * lag verdict; it does not second-guess a fresh one.
 *
 * COST: the suspect list is chunked at `LAG_CHUNK_IDS` (one cap-sized RPC each) and the chunks
 * run in parallel. With zero
 * suspects (a fully-fresh store) stage 2 issues no query at all.
 *
 * Consumed by `api/status.ts` (the Dashboard payload — the most load-bearing consumer: BOTH the
 * per-indicator ages on every served reading and the per-feed pill), by `api/lab.ts` (the `/lab`
 * board) and by `scripts/capture-d4-freshness.ts` (D4's STOP-gate capture), so the capture's per-id
 * fresh/lagging figure is the wiring's own verdict rather than a second copy of the rule.
 */
export async function freshnessFrom(
  store: ReadStore,
  now: Date,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<FreshnessStamp> {
  const ids = [...CADENCE_OF.keys()];
  // ONE clock read for the whole stamp (`now` is passed down), resolved to a date PER FEED — so no
  // two ids can land on different sides of a midnight that ticked mid-request, and stage 2 below
  // classifies against the same date stage 1 scored the id with.
  const todayOf = new Map(ids.map((id) => [id, todayOnFeedCalendar(FEED_TZ_OF.get(id), now)]));

  const { slotIds, seriesById, rawHeadById } = await readStage1Windows(store, ids);

  // The containment candidate pool = EVERY DAILY-cadence id, tagged `independent` unless it is a
  // composite leg (a leg shares its parent's fetch, R14.3). A weekly target grids off these SAME
  // daily candidates — under cadence-aware silent days (§16 ruling 15.2) every daily feed prints on
  // a weekly's non-print weekdays, so none is charged and all stay peers, and §5's "a weekly rides
  // the daily union grid" falls out as a DERIVATION, not a branch.
  //
  // ⚠ ZERO-ROW ids are KEPT in the pool. The {@link MIN_CALENDAR_SOURCES} floor is STRUCTURAL — it
  // asks "does the REGISTRY give this feed ≥2 independent peers", the same registry-shape guard the
  // retired per-cohort source COUNT was. A store that has seeded only one daily feed must still read
  // that feed in slots (its dark peers contribute no dates but keep the grid a calendar); the
  // dark-cohort-reads-0 case is owned by the run heartbeat, NOT re-detected here (publication-
  // calendar.ts ⚠). Dropping zero-row peers would instead make a sparse store THROW the whole stamp.
  const legIds = compositeComponentLegIds();
  // A composite leg carries 0 independent sources of its own; it inherits its PARENT's grid (R14.3 —
  // shared fetch ⇒ shared publication calendar). See {@link compositeLegParentIndex}.
  const legParent = compositeLegParentIndex();
  const allDailyFeeds: FeedObservations[] = [];
  for (const id of slotIds) {
    if ((CADENCE_OF.get(id) ?? "daily") !== "daily") continue;
    allDailyFeeds.push({ id, dates: (seriesById.get(id) ?? []).map((p) => p.date), independent: !legIds.has(id) });
  }
  // A grid is built ONLY for a target that HAS a newest observation (a zero-row id short-circuits to
  // `lag: true` below, before any grid work). `containmentGrid` still THROWS below the source floor
  // or on a genuinely empty target (§12 R2) — an absence reported, never coalesced to 0.
  const gridFor = (id: string): PublicationCalendar =>
    containmentGrid(
      { id, dates: (seriesById.get(id) ?? []).map((p) => p.date), independent: !legIds.has(id) },
      allDailyFeeds,
    );

  // ⚠ CONTAINED PER FEED, never stamp-wide. `containmentGrid` throws by design below
  // `MIN_CALENDAR_SOURCES` (an absence to report, never coalesced to 0) — but until 2026-09-10 that
  // throw escaped the `ids.map` below, and BOTH `api/status.ts` and `api/lab.ts` catch this call at
  // the TOP. One feed that could not be gridded therefore took down the WHOLE stamp: every other
  // feed's age, `/api/status`'s `feedLag` roster AND its lagging pill, and `/api/lab` fell back to
  // `freshnessMissing: true`. Live cause was BRENT — ICE Brent keeps LONDON's holiday calendar, so
  // it is silent on days much of the cohort prints (2026-04-03 Good Friday, 04-06 Easter Monday,
  // 05-04 and 05-25 bank holidays), so at
  // `CONTAINMENT_TOLERANCE = 0` every peer that printed on one is dropped, leaving 1 source. Bisected
  // by `scripts/probe-brent-calendar-floor.ts` (`npm run probe:brent-calendar`) THROUGH the real
  // `containmentGrid`, which also falsifies the staleness story (truncating every peer to BRENT's own
  // newest date still throws).
  //
  // Per-feed degrade: `unmeasured: true`, NO `lag`/`ageDays`/`ageUnit` key — lateness uncomputable, so
  // no consumer counts it behind (`lag === undefined`); distinct from a zero-row id's `lag: true`. Such
  // a feed can still read fresh in `readings[]` via api/status.ts's run-row fallback (`source: "run-row"`).
  const gridOrAbsent = (id: string): PublicationCalendar | null => {
    try {
      return gridFor(id);
    } catch (err) {
      // Loud, and per feed: the served row says THAT there is no measurement, this says which feed
      // and why. Same posture as `api/lab.ts`'s stamp-level warn, one layer down.
      warn(`[feed-lag] no publication calendar for ${id} - serving it as an absence. Cause:`, err);
      return null;
    }
  };

  // Populated only for ids that HAVE a newest observation — see `FreshnessStamp.ageDays`: a
  // zero-row id has no age, and inventing one would read as "fresh today". `ageUnit` shares its keys.
  const ageDays = new Map<string, number>();
  const ageUnit = new Map<string, "slots" | "days">();
  // The grid each slot id's age was counted on — stage 2 recounts that id's day bar on the same one.
  const slotGridOf = new Map<string, PublicationCalendar>();
  const slotTargetOf = new Map<string, string>(); // the id whose closures that grid excuses (a leg: its parent)
  const deepLagBarInAgeUnit = new Map<string, number>();
  const freshness: MemberFreshness[] = ids.map((id) => {
    const newest = seriesById.get(id)?.at(-1)?.date;
    if (newest == null) return { id, lag: true };
    const cadence = CADENCE_OF.get(id) ?? "daily";
    // `todayOf` is keyed by `ids` ITSELF, so its `??` is type narrowing, never a real branch.
    const today = todayOf.get(id) ?? todayOnFeedCalendar(undefined, now);
    if (cadence === "daily" || cadence === "weekly") {
      // SLOT age against the id's OWN containment grid, scored against the id's RESOLVED cut
      // (`LAG_CUT_OF` = `lagCutFor`) — the ONE lag-resolution point. Slice 3 (2026-09-09) converted
      // the RUN path to the same unit and deleted the read-path-only `LAG_SLOT_THRESHOLDS`/
      // `slotCutFor` pair, so this no longer diverges from `stampFreshness` and no longer ignores a
      // per-id `lagAfterDays`. Those overrides are calendar-day values read as slots and are LOOSER
      // than their tier in every case, so repointing here can only relax a flag, never invent one.
      // No calendar ⇒ no slot age. Marked, unaged — never a fabricated 0 (see `gridOrAbsent`).
      // Composite LEG ⇒ score against the PARENT's grid, but ONLY when the parent is a fetched daily
      // feed (chart-only HCX/FDX legs have no series, so keep their own); `newest` stays the leg's own.
      const parentId = legParent.get(id);
      const gridTarget = parentId != null && CADENCE_OF.get(parentId) === "daily" ? parentId : id;
      const grid = gridOrAbsent(gridTarget);
      // No calendar ⇒ lateness uncomputable ⇒ `unmeasured`, NO `lag` key (a zero-row id keeps `lag: true`).
      if (grid == null) return { id, unmeasured: true };
      // Net of the grid target's source/publisher closures in `(newest, today]` (market-closures.ts) — a leg rides
      // its parent's closures as it rides its grid and its delay.
      const age = slotAge(newest, today, grid, (d, post) => isSlotExcused(gridTarget, d, post));
      ageDays.set(id, age);
      ageUnit.set(id, "slots");
      slotGridOf.set(id, grid);
      slotTargetOf.set(id, gridTarget);
      // Scored `age - releaseDelay(id) > cut` (release-delay.ts), the SAME `slotLag` the run path's
      // `resolveFreshness` uses — a healthy T+1 FRED feed (F1, delay 1) reads age 2 every morning and
      // is NOT behind; one missed release still flags the next day.
      // Delay looked up by `gridTarget` — the id whose grid the age was counted on — so a leg riding
      // its parent's grid is scored net of the PARENT's delay (the probe measures legs on that same
      // grid; `release-delay.test.ts` pins leg delay = parent delay).
      return { id, lag: slotLag(age, LAG_CUT_OF.get(id) ?? lagCutFor({ cadence }), gridTarget) };
    }
    // monthly/quarterly stay on CALENDAR days and the resolved `lagAfterDays` cut (§5), untouched.
    // `LAG_CUT_OF` walks the same registry, so its 4th arg is always present.
    const f = assessIndicatorFreshness(newest, today, cadence, LAG_CUT_OF.get(id));
    ageDays.set(id, f.ageDays);
    ageUnit.set(id, "days");
    return { id, lag: f.lag };
  });
  // R10 (B6): an intraday newest row ages 0 on its own date — flag it so the panel labels it INTRADAY.
  const newest = new Map<string, SeriesPoint>();
  for (const f of freshness) {
    const p = seriesById.get(f.id)?.at(-1);
    const head = rawHeadById.get(f.id) ?? p;
    if (head !== undefined) newest.set(f.id, head);
    if (p !== undefined && isProvisional(p, f.id)) f.provisional = true;
  }

  const suspects = freshness.filter((f) => f.lag).map((f) => f.id);
  if (suspects.length === 0) return { freshness, lag: [], ageDays, ageUnit, deepLagBarInAgeUnit, newest };

  // Stage 2 deep-reads the lagging suspects. A SLOT suspect already has its `LAG_SCAN_LIMIT` window
  // from stage 1 (byte-identical — same limit, same store), so only the monthly/quarterly suspects
  // (read `limit: 1` above) need a deep re-read.
  const slotIdSet = new Set(slotIds);
  const points = new Map<string, readonly SeriesPoint[]>();
  for (const id of suspects) if (slotIdSet.has(id)) points.set(id, seriesById.get(id) ?? []);
  const daySuspects = suspects.filter((id) => !slotIdSet.has(id));
  if (daySuspects.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < daySuspects.length; i += LAG_CHUNK_IDS) chunks.push(daySuspects.slice(i, i + LAG_CHUNK_IDS));
    const deep = await Promise.all(chunks.map((c) => store.getSeriesBulk(c, { limit: LAG_SCAN_LIMIT })));
    for (const m of deep) for (const [id, pts] of m) points.set(id, pts);
  }

  const byId = new Map(freshness.map((f) => [f.id, f]));
  const lag: FeedLagNote[] = [];
  for (const id of suspects) {
    const registered = CADENCE_OF.get(id) ?? "daily";
    // The SAME per-feed date stage 1 scored this id against — a UTC date here would let the two
    // stages disagree about the age of the very row one of them just called lagging.
    const today = todayOf.get(id) ?? todayOnFeedCalendar(undefined, now);
    const row = lagRowFor({
      id,
      registered,
      // Stage 1 above already scored this id against `LAG_CUT_OF`; stage 2 classifies against the
      // SAME resolved cut (E7 Stage 3.6) so the board's FRESH/LATE boundary and the notify line's
      // `verdictHoldLegs` cannot disagree. Both maps walk the same registry, so the lookup always hits;
      // the fallback goes through `lagCutFor` too, never straight at the tier table.
      cut: LAG_CUT_OF.get(id) ?? lagCutFor({ cadence: registered }),
      // Same walk again; `false` is the STRICT arm, so a missing entry can only over-report DEEP-LAG,
      // never silence one.
      explicit: EXPLICIT_OF.get(id) ?? false,
      dates: (points.get(id) ?? []).map((p) => p.date),
      today,
    });
    if (lagTier(row.label) === null) continue; // FRESH-by-own-rhythm / too-short window ⇒ no tier
    const entry = byId.get(id);
    if (entry) entry.label = row.label;
    const deepLagBar = row.gaps === 0 ? null : deepLagRhythm(row) * DEEP_LAG_MULTIPLE;
    const slotGrid = slotGridOf.get(id);
    if (deepLagBar != null && ageUnit.has(id)) {
      // Same excusal as the age it is compared against — a bar counted WITH holidays beside an age counted without
      // them would be one slot looser every holiday week.
      const target = slotTargetOf.get(id) ?? id;
      deepLagBarInAgeUnit.set(
        id,
        slotGrid ? slotAge(isoDaysBefore(today, deepLagBar), today, slotGrid, (d, post) => isSlotExcused(target, d, post)) : deepLagBar,
      );
    }
    lag.push({
      id,
      label: row.label,
      // NO-DATA has no newest observation, so `lagRowFor` reports `Infinity` — served as `null`
      // (JSON has no Infinity, and a coerced 0 would read as "fresh today").
      age: Number.isFinite(row.age) ? row.age : null,
      p90Gap: row.gaps === 0 ? null : row.p90Gap,
      // The bar the DEEP-LAG arm actually applied (E7 §Stage 4.7-R2) — `2 × p90Gap` on the strict arm,
      // `2 × max(p90Gap, LAG_THRESHOLDS[registered])` (the cadence TIER, not the resolved cut) for
      // an explicitly registered id. Served beside `p90Gap` so the footnote names the bar rather than
      // always claiming "own p90"; null on the same condition.
      deepLagBar,
      lagCut: row.cut,
      registered,
    });
  }
  return { freshness, lag, ageDays, ageUnit, deepLagBarInAgeUnit, newest };
}
