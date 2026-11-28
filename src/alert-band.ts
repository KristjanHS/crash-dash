/**
 * T1-dial → ntfy alert band (Slice 3, 2026-07-12).
 *
 * The single danger source for the production alert path. Retires
 * the legacy channel-verdict engine (retired 2026-07-15; frozen copy legacy-ladder.ts deleted 2026-08-15) and its 9-cell market×mode crash-detection fan-out
 * (the retired founding-goal engine). The band stays the same 4-value enum
 * (OK/WATCH/WARNING/CRITICAL) — only its *derivation* changes:
 *
 *   dialBand   = regimeToBand(dial.notifyRegime)                // clean 1:1, NOTIFY axis
 *   laggedBand = deEscalationLag(dialBand, recentDialBands, N)  // up now, down after N holds
 *   floor      = escalatorFloor(readings, geoFlags, r4Phase, fired)  // max of 4 escalators
 *   finalBand  = max(laggedBand, floor)                         // escalators bypass the lag
 *
 * Pure: no IO, no clock. Notify-only.
 */
import type { FamilyRegime, LabFloorId, LabBand, LabBandFloor, LabBandMember, FamilyPanel } from "./families.js";
import { STATE_RANK, type State } from "./domain-types.js";
import type { Cadence, Reading } from "./domain-types.js";
import {
  R4_ENTER_RUNG,
  R4_ENTER_FAMILIES,
  R4_HY_TAIL,
  R4_VT_TAIL,
  R4_EXIT_HY,
  R4_EXIT_VT,
  type R4Phase,
} from "./r4.js";
import { EARLY_WARN_MEMBERS, type T1DialResult } from "./t1dial.js";
import { type AlertLevel, ALERT_RANK, someDailyFeedFresh } from "./ladder.js";
import { channelScore } from "./channel-score.js";
import { distinctFactorCount } from "./geo-factor.js";
import { loadGeoInputs } from "./geo.js";
import { ALL_INDICATORS } from "./registry.js";
import { BAND_INERT_SCORED_IDS } from "./registry-fred.js";
import { PLACEHOLDER_STATE_IDS, RS_LEG_OF } from "./registry-price.js";
import { STAGE1_TRIGGER_IDS } from "./registry-geo.js";

/** F1's LIVE registry label (`HY OAS`) — read off the `label` FIELD, never hand-typed and never
 *  inferred from the id (this plan's Stage 1.1 lesson: the `SPCONC` gloss rows were voided
 *  for being authored from ids). The R4 floor's HY-tail member row + reason (buildLabBand below) is
 *  served through api/lab.ts and rendered by public/band-panel.js, so hand-typing the retired
 *  `HY-OAS` form there put it on live /lab (Addendum B finding 1). Sourcing it here keeps it synced. */
const HY_OAS_LABEL = ALL_INDICATORS.find((i) => i.id === "F1")!.label;

/** De-escalation lag length in CALENDAR DAYS: a lower dial band must hold this
 *  many consecutive prior days before the band steps down (decision, N=2 —
 *  mirrors the repo's 2-close indicator confirmation buffer and the dropped D1
 *  asymmetric hold's intent). Counts DAYS, not runs: the baseline is read via
 *  `store.getLastBandBefore` with a UTC-midnight cut (`run-cycle.ts`), so an intraday
 *  re-run cannot consume the N−1 prior-day slot. */
export const DE_ESCALATION_DAYS = 2;

/**
 * The two HALF-MET early-warn pair notes. A pair is half-met when exactly one of its legs is past
 * its cut; the note says THAT PAIR is quiet — it says nothing about the ew floor, which another
 * pair may be holding at WATCH or worse, so the wording must stay pair-scoped.
 *
 * Exported because four test sites assert this copy — `src/alert-band.floors.test.ts` and
 * `public/band-panel.test.js`, the latter including an ABSENCE assertion, which goes vacuous the
 * moment a hand-typed literal drifts from the string the code emits. Import it; never re-type it.
 * @internal
 */
export const EW_HALF_MET_BREAK = "break past cut; rel-strength intact - pair quiet";
/** @internal */
export const EW_HALF_MET_RS = "rel-strength breakdown; break not past cut - pair quiet";

/**
 * RATE-stress escalator threshold (was `CHANNEL_CUTS.RATE.watch` in the now-deleted
 * legacy engine). RATE base score at/above this floors the band
 * to WATCH.
 */
const RATE_STRESS_FLOOR = 2;

/** Credit escalator, BOTH keys turned (W3-d/OQ-2): unchanged from the pre-gate rule. */
const CREDIT_FIRED_FLOOR: AlertLevel = "CRITICAL";
/**
 * Credit escalator, ONE key only (F1/F2 confirmed RED but no FIRE family firing).
 * DERIVED, not chosen: it is the band the two-key model itself already admits for
 * a primed-but-unfired world — regimeToBand(notifyRegimeFor(rungCut(ARMED_UNFIRED_CAP)))
 * = regimeToBand(notifyRegimeFor(0.5)) = regimeToBand("Stress") = "WARNING".
 * (`rungCut` is the one rung→score span, families.ts; NOTIFY_REGIME_CUTS is expressed
 * through it too, so this derivation and the cut it lands on cannot drift apart.)
 *
 * It reads the NOTIFY cuts, not the dial's (W3-c): this is a statement about the band
 * that gets PUSHED. If the notify Caution/Stress cut later moves while this stayed on
 * the dial axis, the escalator could put the band somewhere the notify dial cannot
 * reach for the same world — silently retiring the invariant on the next line.
 * So the credit escalator can no longer put the band anywhere the dial couldn't
 * have put it for the same world — which is exactly what "behind the two-key model" means.
 * Pinned against drift by the derivation test in alert-band.compose.test.ts.
 * @internal
 */
export const CREDIT_UNFIRED_FLOOR: AlertLevel = "WARNING";

/**
 * GEO crisis-stage → extra geo flags (Stage 4, Option A count-fold — RULED 2026-07-24).
 * Index = the declared `crisisStage` (config.json, playbook §3 ladder); the value ADDS into
 * `geoBase` in {@link escalatorFloorBreakdown} alongside manual flags + elevated auto GEO
 * readings, reusing the existing 1=WATCH / 2=WARNING geo calibration:
 *
 *   stage 0 (none)          → +0
 *   stage 1 (WATCH)         → +1  — DECLARED 1 is retired (loadGeoInputs throws; the auto
 *                                   heldStage1 machine in escalatorFloorBreakdown replaces it)
 *   stage 2 (SERIOUS)       → +2  — WARNING floor alone; the ONE declared crisis rung since
 *                                   the A2 merge (2026-08-15) absorbed declared 3
 *   stage 3                 → +2  — FROZEN-REPLAY ALIAS only: loadGeoInputs rejects a declared 3,
 *                                   but a frozen scenario's stored stage bypasses the loader
 *   stage 4 (DE-ESCALATION) → +1  — until `geoCalmStreak >= DE_ESCALATION_DAYS` releases it to +0
 *
 * The geo floor's WARNING cap is untouched — the stage can never lift geo past WARNING.
 */
export const STAGE_TO_FLAGS = [0, 1, 2, 2, 1] as const;

/**
 * FamilyRegime → band, clean 1:1 (decision #1). Its sole production input is
 * `dial.notifyRegime`, a RUNG-BOUNDARY map over `dangerScore = (rung−1)/8` through
 * `NOTIFY_REGIME_CUTS` (`t1dial.ts`/`families.ts notifyRegimeFor`) — cuts at rungs
 * 3/5/7 since the W3-c §6 ruling, no longer "the quartiles" — NOT `regimeFor`,
 * which is display-only since W3-c. The graded `systemicBump` is already baked into
 * `rung` before `dangerScore`, so it flows through for free.
 */
const REGIME_BAND: Record<FamilyRegime, AlertLevel> = {
  Calm: "OK",
  Caution: "WATCH",
  Stress: "WARNING",
  Crisis: "CRITICAL",
};

export function regimeToBand(regime: FamilyRegime): AlertLevel {
  return REGIME_BAND[regime];
}

/** max over a set of bands (OK over an empty set), by ALERT_RANK. @internal */
export function maxBand(...bands: AlertLevel[]): AlertLevel {
  return bands.reduce<AlertLevel>((a, b) => (ALERT_RANK[a] >= ALERT_RANK[b] ? a : b), "OK");
}

/**
 * One lagging leg surfaced by {@link verdictHoldLegs}: the indicator whose freshest observation exceeds its
 * RESOLVED lag cut — `ind.lagAfterDays ?? LAG_THRESHOLDS[ind.cadence ?? "daily"]`, resolved
 * through `lagCutFor` (ladder.ts) AT THE STAMP (`stampFreshness`, scorers-core.ts), not here —
 * reported for the notify FLAG. The `cadence` field below is the
 * leg's REGISTERED tier and is not necessarily the cut it was scored against (E7).
 */
export interface VerdictHoldLeg {
  id: string;
  label: string;
  /** The stamped age, in the leg's OWN unit — PUBLICATION SLOTS for daily/weekly, calendar days for
   *  monthly/quarterly (slice 3). Copied off `Reading.ageDays`, never recomputed here. */
  ageDays: number;
  cadence: Cadence;
}

/**
 * W4-e (FLAG slice): the per-leg lag guard for the notify path. Pure — no IO, no clock, and since
 * slice 3 (RULED `[USER]` 2026-09-09) NO FRESHNESS COMPUTATION EITHER.
 *
 * ⚠ IT READS THE STAMP, IT DOES NOT RESOLVE ONE. `r.lag`/`r.ageDays`/`r.unit` were already resolved
 * by `stampFreshness` (scorers-core.ts) — the run path's single freshness site — through the one
 * `lagCutFor`, in the id's own PUBLICATION SLOTS for a daily/weekly leg and calendar days for a
 * monthly/quarterly one. Calling `assessIndicatorFreshness` here a second time is exactly the defect
 * slice 3 forbids: it would score a freshly-computed number against a cut restated in the other
 * unit. `src/run-path-freshness-callers.test.ts` greps the tree and reds on a second caller.
 *
 * ⚠ THE `today` PARAMETER IS GONE. The evaluation clock enters once, at the stamp (`freshnessToday`
 * in run-cycle-dial.ts); a second clock here could disagree with the one the stamp was resolved against.
 *
 * ⚠ `lag === undefined` (never assessed — no publication grid could be built for that id, see
 * `lagCalendarsFrom`) is NOT lagging: this fails toward not holding the band, exactly as
 * `someDailyFeedFresh` fails toward not arming, and the whole-run calendar-day heartbeat
 * (`assessFreshness`, run-core.ts) is the backstop for the case where nothing published at all.
 *
 * ⚠ VALUE-ONLY ids are EXCLUDED (`PLACEHOLDER_STATE_IDS`, registry.ts) — this is a BAND fix, not a
 * cosmetic one. The result feeds `verdictHoldFloor` in run-core.ts, which floors the final band at the
 * prior persisted band while ≥1 leg is lagging. The W4-e rationale for that hold is "a lag-benign leg
 * must not be trusted to have IMPROVED the band" — vacuous for a leg that contributes nothing to the
 * band in the first place. The failure mode it prevents: a display-only card whose feed freezes without
 * throwing keeps emitting a Reading with an old date, which would make the notify band monotone
 * non-decreasing on every subsequent run until someone noticed. VTP/G1/BRENT are NOT
 * excluded: their empty `thresholds` means "bespoke scorer, not classify()", so they are genuinely
 * scored and their blindness is real. Pinned in alert-band.compose.test.ts over the whole set.
 *
 * ⚠ `BAND_INERT_SCORED_IDS` (registry.ts) is ALSO excluded, by the same vacuity argument on the
 * other axis: genuinely scored, but with no family seat and no `MEMBER_WEIGHT` row the leg
 * contributes nothing to any band, so its blindness cannot pin one.
 */
export function verdictHoldLegs(readings: Reading[]): VerdictHoldLeg[] {
  return readings
    .filter((r) => !PLACEHOLDER_STATE_IDS.has(r.indicator.id) && !BAND_INERT_SCORED_IDS.has(r.indicator.id))
    .filter((r) => r.lag === true)
    .map((r) => ({
      id: r.indicator.id,
      label: r.indicator.label,
      // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `lag === true` is only ever set beside an `ageDays` (the SAME
      // `Freshness` object), so the `?? 0` is type narrowing over a pair that cannot half-exist,
      // never a fabricated age. `stampFreshness` writes both or neither.
      ageDays: r.ageDays ?? 0,
      // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — "daily" is the `Indicator` default that
      // `lagCutFor` itself applies (docblock above); this mirrors it for the
      // reported field rather than inventing a cadence.
      cadence: r.indicator.cadence ?? "daily",
    }));
}

/**
 * THE coverage-floor arming predicate (R4/R5):
 * at least one family's verdict is held by data that is not live, WHILE the rest of the world is
 * still reporting. Both halves are required:
 *
 *   - `panel.some((f) => f.coverageDegraded === true)` — the per-family claim, already resolved by
 *     `families.ts` (a member past its own `lagCutFor`, or absent, holding or tying the family's
 *     worst-of verdict; a rank-7 CARRIED family is degraded unconditionally). `undefined` ⇒ not
 *     degraded — fail-toward-NOT-arming.
 *   - {@link someDailyFeedFresh} — divergence, not age (§0.3): a market holiday or a whole-run fetch
 *     outage makes EVERY feed lag at once and must NOT arm the floor. Only a fresh DAILY peer
 *     proves the blindness is local to the degraded family.
 *
 * `panel` is the CARRIED DIAL panel (`assembleDial`'s `globalPanel`), so the floor judges exactly the
 * population the dial banded on. Pure: `alert-band` reads no store and no clock — the caller resolves
 * both inputs.
 */
export function coverageArmed(
  panel: readonly FamilyPanel[],
  rows: readonly { cadence?: Cadence; lag?: boolean }[],
): boolean {
  return panel.some((f) => f.coverageDegraded === true) && someDailyFeedFresh(rows);
}

/**
 * The hard-escalator floor (decision #4/#5, Slice 3): danger that a family-only
 * dial can miss reaches the band directly, bypassing the de-escalation lag. The
 * band never drops below the max of these four floors, and the floors apply
 * INSTANTLY in both directions.
 *
 * ⚠ UPWARD, that instant application rests on no de-flapping: the directional fold
 * (2026-08-26, instant-up) confirms a worse raw state same-day, so a SINGLE-close
 * F1/F2 RED can take the band straight to the CRITICAL credit floor
 * (pinned behaviourally in run.wiring.persist.test.ts: band OK → CRITICAL on one close). That is
 * ACCEPTED, not an oversight — the ruling trades more pushes for zero escalation lag,
 * and the notify path is up-only; DOWNWARD the 2-close stand-down now de-flaps the
 * floor's release. R4 still carries its own phase machine and
 * GEO still reads a scored state; neither is what makes the floors instant.
 *
 *   Credit blowout | EITHER F1 or F2 confirmed RED, AND dial.fired | CRITICAL (else WARNING)
 *   GEO            | base ≥1 / ≥2 (manual geoFlags + auto G1) | WATCH / WARNING
 *   R4 breaker     | r4Phase === "cash"                      | CRITICAL
 *   RATE stress    | RATE base score ≥ RATE_STRESS_FLOOR     | WATCH
 *
 * `geoFlags` is the manual-only count (`loadGeoInputs().flagCount`); the auto G1 oil shock
 * lives in `readings` on the GEO channel (non-GREEN = one flag), so the GEO base
 * recombines BOTH here or the oil escalator silently drops (Stage 2 doc note).
 * `crisisStage` (Stage 4) adds `STAGE_TO_FLAGS[stage]` more — default 0 = no stage
 * declared (pure-logic tests / sims / probes, which have no replayable stage history).
 *
 * ⚠ THE OIL DOUBLE-COUNT IS RULED INTENDED, NOT A DUPLICATE TO NET OUT (2026-08-02,
 * belt-and-braces). The SAME oil shock that raises the GEO
 * base here also enters the share arm's capped `gp` term (`legDangerShare`, `danger-share.ts`) and moves
 * the held leg. These are different AXES: this floor says how LOUD to be,
 * the `gp` term says WHAT TO HOLD. Neither side is attenuated to compensate for the other, so do not
 * "fix" the apparent duplication by damping this escalator.
 */
export function escalatorFloor(
  readings: Reading[],
  geoFlags: number,
  r4Phase: R4Phase,
  fired: boolean,
  ewFire = false,
  crisisStage = 0,
  coverageArmed = false,
): AlertLevel {
  return escalatorFloorDetail(readings, geoFlags, r4Phase, fired, ewFire, crisisStage, coverageArmed, DE_ESCALATION_DAYS).band;
}

/** Which escalator produced the binding floor (rank 13 band-reason). `ew` is the
 *  capped EARLY-WARN sub-signal (fast-breaks redesign §1) — listed LAST so a real actionable
 *  cause (credit/r4/geo/rate) is always named over the advisory nudge on a tie.
 *  `coverage` (R4) is listed after even
 *  `ew`, for the same reason taken one step further: it is not a market reading at all, but the
 *  WATCH-capped claim "a family's verdict is held by data that is not live". On a tie it must lose
 *  the `source` to every real cause, including the advisory nudge.
 *  ⚠ ORDER IS LOAD-BEARING: most-severe-first, and that order IS the tie precedence
 *  (`escalatorFloorBreakdown` picks with strict `>`), so `buildLabBand` reads this array rather
 *  than re-typing it. It is also the enumeration the band-reason coverage guard in
 *  `alert-band.floors.test.ts` derives its expected set from — adding a source here without an arm there
 *  goes red. @internal */
export const FLOOR_SOURCES = ["credit", "r4", "geo", "rate", "ew", "coverage"] as const;

export type FloorSource = (typeof FLOOR_SOURCES)[number];

// Compile-time pin: the /lab wire's `LabFloorId` (families.ts, kept local there to break the
// import cycle) MUST stay equal to `FloorSource` — a bidirectional `extends` so adding a floor
// to either side without the other is a tsc error, not a silent wire mismatch.
type _FloorIdParity = [FloorSource] extends [LabFloorId]
  ? ([LabFloorId] extends [FloorSource] ? true : never)
  : never;
const _floorIdParity: _FloorIdParity = true;
void _floorIdParity;

/** One escalator floor's OWN read (not the binding max): its computed band level plus the cap it
 *  can ever reach (rate/ew: WATCH; geo: WARNING; credit/r4: CRITICAL). The `cap` is the single
 *  source the /lab BAND column reads to build each member cell's capped RAG scale (§5). */
interface EscalatorFloorLevel {
  id: FloorSource;
  level: AlertLevel;
  cap: AlertLevel;
  /** `geo` ONLY (R9, 2026-07-31) — the COMPONENTS of `geoBase`, emitted where the count is actually
   *  summed so the /lab row can print the arithmetic without re-deriving it in a second place
   *  (a browser-side recount of "GEO-channel readings that are not GREEN" is exactly the drift the
   *  single-source rule forbids). Absent on every other floor: they have no count to explain. */
  geoBasis?: GeoBasis;
}

/** The addends behind the geo escalator base (`geoBase = manual + auto + stage`), carried out of
 *  {@link escalatorFloorBreakdown} so `buildLabBand` can render the sum in words. `auto` lists the
 *  ids of the ELEVATED auto GEO-channel readings so the row can NAME them, and `autoFactors` is the
 *  number those ids actually contribute — one per DISTINCT `geoFactor` among them (§11.1), NOT one
 *  per id. The two differ exactly when several reads of one factor are lit together (BRENT + OVX
 *  lit ⇒ `auto: ["BRENT","OVX"]`, `autoFactors: 1`), which is the whole point of the rule; anything
 *  printing the arithmetic must sum `autoFactors`, never `auto.length`, or the displayed terms will
 *  not add up to `total`. `total` is the summed base the floor cut reads. */
export interface GeoBasis {
  total: number;
  manual: number;
  auto: string[];
  autoFactors: number;
  /** The DECLARED-stage addend (2/3 ⇒ 2; 4 ⇒ 1 until the calm streak releases it to 0). */
  stage: number;
  /** The auto stage-1 hold's extra addend — 1 only when held with no lit factor (max, never sum). */
  hold: number;
  /** `geoCalmStreak` progress toward `DE_ESCALATION_DAYS`, rendered only while `hold > 0`. */
  dwell: number;
}

/** {@link escalatorFloorDetail}'s binding `{band, source}` PLUS every floor's own level — the one
 *  derivation the /lab BAND column's read-time recompute and the notify path share, so the
 *  per-floor display can never disagree with the band that was actually pushed. The `floors` array
 *  is most-severe-first (credit, r4, geo, rate, ew, coverage), matching the binding precedence. */
interface EscalatorBreakdown {
  band: AlertLevel;
  source: FloorSource | null;
  floors: EscalatorFloorLevel[];
}

/** The distinct EARLY-WARN advisory label (fast-breaks redesign K-notify) — carried by the
 *  `floor:ew` band-reason so a lone fast-break WATCH reads as CAUTION, not an actionable de-risk.
 *  The action rule IS the copy: monitor, do not de-risk. */
export const EARLY_WARN_ADVISORY = "EARLY-WARN: fast downside break - monitor, do not de-risk";

/**
 * `escalatorFloor` PLUS the source of the binding floor — the single derivation both the
 * plain-band wrapper above and the rank-13 band-reason (`computeAlertBandDetail`) read, so
 * the persisted reason can never re-derive-and-drift from the band it explains. On a tie at
 * the max band the earlier-listed source wins (credit > r4 > geo > rate — most-severe first);
 * `source` is null only when every floor is OK (band === "OK").
 */
export function escalatorFloorDetail(
  readings: Reading[],
  geoFlags: number,
  r4Phase: R4Phase,
  fired: boolean,
  ewFire = false,
  crisisStage = 0,
  coverageArmed = false,
  geoCalmStreak = DE_ESCALATION_DAYS,
): { band: AlertLevel; source: FloorSource | null } {
  const { band, source } = escalatorFloorBreakdown(
    readings,
    geoFlags,
    r4Phase,
    fired,
    ewFire,
    crisisStage,
    coverageArmed,
    geoCalmStreak,
  );
  return { band, source };
}

/**
 * {@link escalatorFloorDetail} widened to every floor's own level (not just the binding one) —
 * the derivation the /lab BAND column recomputes at read time. Computes every floor level
 * from the SAME predicates the binding path uses (moved here verbatim, so `escalatorFloorDetail`
 * and the plain-band wrapper both read this — no drift possible), then picks the binding floor by
 * `ALERT_RANK` with strict `>` (first candidate at the max wins ⇒ the most-severe-first order IS
 * the tie precedence: credit > r4 > geo > rate > ew > coverage). Pure. Behaviour-identical to the pre-split
 * `escalatorFloorDetail`, pinned by alert-band.*.test.ts.
 */
export function escalatorFloorBreakdown(
  readings: Reading[],
  geoFlags: number,
  r4Phase: R4Phase,
  fired: boolean,
  ewFire = false,
  crisisStage = 0,
  // R4 (2026-08-01) — the COVERAGE claim, resolved by the caller: at least one family's verdict is
  // held by data that is not live, while other daily feeds are still flowing. A pure boolean here on
  // purpose — this module reads no panel, no store and no clock; the arming predicate itself lands
  // in Stage 3.2. Defaulted `false`, so every existing caller's band is byte-unchanged.
  coverageArmed = false,
  // The persisted calm streak (run-core.ts), resolved by the caller — pure here. Default = the
  // dwell length, i.e. "assume calm": streak-less callers see no hold and a RELEASED declared 4.
  geoCalmStreak = DE_ESCALATION_DAYS,
): EscalatorBreakdown {
  // Credit blowout — either F1 or F2 confirmed RED — GATED BEHIND THE TWO-KEY MODEL
  // (W3-d/OQ-2, 2026-07-18): a single confirmed RED no longer forces CRITICAL on its own.
  // The gate reads `fired` ONLY, never `armed`: for this predicate `armed` is provably
  // tautological (F1/F2 RED ⇒ credit family worst-state RED ⇒ credit firing ⇒ the dial is primed), so
  // ANDing it in would add coupling with zero discrimination. The meaningful key is a
  // FIRE/coincident family actually firing — credit spreads blowing out with no market
  // confirmation is ONE key, and one key must not reach the top tier.
  // (Supersedes the 2026-07-12 "single RED = CRITICAL" rule, which this rung ruled a bug.)
  const creditBlowout = readings.some(
    (r) => (r.indicator.id === "F1" || r.indicator.id === "F2") && r.state === "RED",
  );
  const creditFloor: AlertLevel = creditBlowout
    ? (fired ? CREDIT_FIRED_FLOOR : CREDIT_UNFIRED_FLOOR)
    : "OK";

  // GEO base = manual flags + one flag per elevated auto FACTOR + the declared stage's flags
  // (the GEO COUNT calibration — not a state-rank SUM; the rank below only spells the elevated
  // PREDICATE, it is never added up). The auto term counts DISTINCT
  // `geoFactor`s among the confirmed non-GREEN GEO readings, NOT the readings themselves
  //: G1, BRENT and OVX are three reads of
  // the OIL factor, so all three lit at once still buy ONE flag. Two alternatives were USER-
  // DECLINED in §11.1 and must not be "simplified" back in: weight-gating the count (only ids
  // with a MEMBER_WEIGHT row count — it drops the live floor two tiers, since the weighted G1 is
  // the GREEN one) and gating on `provisional` (it would make a provenance flag silently
  // load-bearing on the notify path, so promoting an id out of provisional would move the band
  // as a side effect). What feeds the count is ALL that changed here: the `>= 2 ⇒ WARNING` /
  // `>= 1 ⇒ WATCH` cut and the manual addend are ruled deliberately UNCHANGED.
  // Declared stage 2 adds STAGE_TO_FLAGS[2]; index 3 is a frozen-replay alias (loadGeoInputs rejects a live 3). A declared 4 COMPOUNDS with a lit factor
  // (base 2 — ruled intended) until the calm streak dwells DE_ESCALATION_DAYS and releases it
  // to 0. A declared 1 contributes nothing here — loadGeoInputs already throws on it; the AUTO
  // stage-1 machine is the heldStage1 max-fold below. Fail-loud 0–4 index guard kept.
  const stageFlags = STAGE_TO_FLAGS[crisisStage];
  if (stageFlags === undefined) {
    throw new Error(`crisisStage must be an integer 0-4, got ${crisisStage}`);
  }
  const declaredTerm =
    crisisStage === 2 || crisisStage === 3
      ? stageFlags
      : crisisStage === 4
        ? (geoCalmStreak >= DE_ESCALATION_DAYS ? 0 : stageFlags)
        : 0;
  // The elevated auto GEO readings are still captured BY ID (all of them, unchanged) so the /lab
  // geo row can NAME what is lit — `= 1 manual + 1 auto (BRENT, OVX)` — off this one summation;
  // see `GeoBasis`. The COUNT below is over factors, so `auto.length` and the auto addend
  // deliberately differ once two reads of one factor are lit.
  // "Elevated" is spelled with `STATE_RANK` (the seam every other rollup uses — `families.ts`'s
  // `elevated`, `t1dial.ts`'s hold) rather than the ad-hoc `!== "GREEN"` this line used to carry.
  // `State` has exactly three inhabitants and `Reading.state`
  // is non-optional, so the two spellings agree on EVERY value the TYPE admits — the swap is an
  // identity over `State`'s inhabitants, not a retune, and the ruled `>= AMBER` predicate is now
  // stated once instead of implied. `alert-band.compose.test.ts` pins that with the exhaustive table
  // enumerated from `STATE_RANK`; no replay was run because the input cannot move within the type
  // (claim-verification §28 — a no-move proof over an immovable input).
  //
  // ⚠ The identity is over the TYPE, and a rogue DB string sits outside it: `readings.state` is
  // `text not null` with NO CHECK constraint (`20260626061924_init_schema.sql`), coerced by two bare
  // `as State` casts in `store.ts` — `rowToSeriesPoint` and `getReadingsForRun`, NOT `api/lab.ts`'s
  // `reconstructReadings`, which only forwards an already-typed field. Such a string fails QUIET here
  // (`STATE_RANK[x]` is `undefined`, `undefined >= 1` is false) — the OPPOSITE direction from the
  // untagged-`geoFactor` fallback below, which is deliberately "never quieter than before".
  // RULED 2026-08-09 [USER]: accept fail-quiet. Every write path writes an already-typed `State`, so a
  // rogue value is reachable only by hand-written SQL. Add no CHECK constraint and no read-seam guard.
  // litSet = confirmed ≥ AMBER on channel GEO OR a stage-trigger id (T5YIFR rides CONTEXT, so the
  // channel filter alone would drop the de-anchoring trigger from the fold).
  const litGeo = readings.filter(
    (r) =>
      (r.indicator.channel === "GEO" || STAGE1_TRIGGER_IDS.has(r.indicator.id)) &&
      STATE_RANK[r.state] >= STATE_RANK.AMBER,
  );
  const autoGeoIds = litGeo.map((r) => r.indicator.id);
  // An UNTAGGED lit GEO reading falls back to its own id, i.e. it counts as its own factor — the
  // pre-§11.1 behaviour, chosen so a missing tag can only ever be as loud as before, never
  // silently soften the floor. The every-GEO-id-has-a-factor assertion in alert-band.compose.test.ts is
  // what keeps that branch unreachable in the shipped registry.
  // The collapse itself is `distinctFactorCount` (geo-factor.ts) — the SAME seam `diffusionLabel`
  // (families.ts) counts breadth with, so the floor and the printed count cannot drift (R2).
  const autoGeoBase = distinctFactorCount(
    litGeo,
    (r) => r.indicator.geoFactor,
    (r) => r.indicator.id,
  );
  // autoTerm = max(factor count, heldStage1 ? 1 : 0) — max, never sum: the stand-down dwell folds
  // through the SAME one-factor-one-flag seam, so a single oil print stays WATCH (base 1).
  // A DECLARED stage ≥2 overrides the auto machine outright (plan Decision): declared 4 carries
  // its own dwell in declaredTerm above, so the hold must not double-count the same streak.
  const heldStage1 = crisisStage < 2 && geoCalmStreak < DE_ESCALATION_DAYS;
  const holdAddend = Math.max(autoGeoBase, heldStage1 ? 1 : 0) - autoGeoBase;
  const geoBase = geoFlags + autoGeoBase + holdAddend + declaredTerm;
  const geoBasis: GeoBasis = {
    total: geoBase,
    manual: geoFlags,
    auto: autoGeoIds,
    autoFactors: autoGeoBase,
    stage: declaredTerm,
    hold: holdAddend,
    dwell: geoCalmStreak,
  };
  const geoFloor: AlertLevel = geoBase >= 2 ? "WARNING" : geoBase >= 1 ? "WATCH" : "OK";

  // R4 breaker — terminal cash zone forces CRITICAL. Rarely adds a tier (cash is
  // only reached past rung 9 ⇒ dial already Crisis→CRITICAL); the belt-and-suspenders.
  const r4Floor: AlertLevel = r4Phase === "cash" ? "CRITICAL" : "OK";

  // RATE stress — base score (non-confirmer RATE readings; R7 is the confirmer) at
  // or above the floor. Uses `channelScore` (rehomed to channel-score.ts, O2 step 1).
  const rateBase = channelScore(
    readings.filter((r) => r.indicator.channel === "RATE" && !r.indicator.confirmer),
  );
  const rateFloor: AlertLevel = rateBase >= RATE_STRESS_FLOOR ? "WATCH" : "OK";

  // EARLY-WARN sub-signal (fast-breaks redesign §1, K-notify) — a fast downside break (ANY
  // `EARLY_WARN_MEMBERS` detector AMBER-or-worse) lifts the band to WATCH as a bounded advisory nudge. HARD CAP (D-B, the
  // load-bearing safety property): this expression is STRUCTURALLY incapable of returning above
  // WATCH — the ternary's only non-OK arm is the literal "WATCH", so `ewFloor` can NEVER drive
  // WARNING/CRITICAL no matter what `ewFire` is. `ewFire` is the dial's `fastBreakEW` (single-sourced
  // via `earlyWarnFires`, threaded through by the caller); it is DECOUPLED from `armed`/`fired`, so a
  // lone break with credit/rates calm cannot arm the crisis band (V-arm).
  const ewFloor: AlertLevel = ewFire ? "WATCH" : "OK";

  // COVERAGE (R4) — "we cannot see", never "the market moved". Same HARD CAP shape as `ewFloor`:
  // the only non-OK arm is the literal "WATCH", so this floor is STRUCTURALLY incapable of driving
  // WARNING/CRITICAL — a blind run can never reproduce a crisis band out of blindness alone.
  const coverageFloor: AlertLevel = coverageArmed ? "WATCH" : "OK";

  // Each floor's `cap` = the highest band its own expression can EVER produce: credit/r4 reach
  // CRITICAL, geo tops out at WARNING, rate/ew are WATCH-capped (ew's hard cap above is the
  // load-bearing D-B safety property). Ordered most-severe-first so the reduce keeps the FIRST
  // floor at the max — the array order IS the binding tie precedence (credit > r4 > geo > rate >
  // ew, coverage). EARLY-WARN advisory LATE: WATCH-capped, it only ever ties geo/rate at WATCH and
  // loses the `source` to them (a real cause named over the nudge); it binds `ew` only as the SOLE
  // non-OK floor. DELIBERATELY UNCHANGED by W3-d: at the unfired tier credit (WARNING) ties a
  // geoBase≥2 WARNING and still wins `source`; R4's CRITICAL outranks an unfired credit.
  // COVERAGE is LAST of all (R4, 2026-08-01): it says "we cannot see", so on a WATCH tie every real
  // cause — rate and even the ew nudge — must be named over it. This ORDER is the whole tie rule.
  const floors: EscalatorFloorLevel[] = [
    { id: "credit", level: creditFloor, cap: "CRITICAL" },
    { id: "r4", level: r4Floor, cap: "CRITICAL" },
    { id: "geo", level: geoFloor, cap: "WARNING", geoBasis },
    { id: "rate", level: rateFloor, cap: "WATCH" },
    { id: "ew", level: ewFloor, cap: "WATCH" },
    { id: "coverage", level: coverageFloor, cap: "WATCH" },
  ];
  let best: { band: AlertLevel; source: FloorSource | null } = { band: "OK", source: null };
  for (const f of floors) {
    if (ALERT_RANK[f.level] > ALERT_RANK[best.band]) best = { band: f.level, source: f.id };
  }
  return { band: best.band, source: best.source, floors };
}

/** R4 phase → its display tone: equity is calm, the terminal cash zone is RED, a laddered re-entry
 *  is AMBER (danger receding but not clear). The two arming tones went with the arming ladder
 *  (NF-1(A), 2026-07-26) — `Record<R4Phase, State>` totality is what keeps this table honest.
 *
 *  ⚠ This is the FLOOR-HEAD phase chip's tone ([USER] E5, 2026-07-26), no longer the r4 ROWS' tone.
 *  It used to be each row's `state`/`cappedState`, which made all four rows move together and so
 *  said nothing about which gate was close; rows now carry {@link r4ProximityTone}. The phase is
 *  still real information, so it survives on the floor head as `LabBandFloor.phase`/`phaseState`. */
const R4_PHASE_TONE: Record<R4Phase, State> = {
  equity: "GREEN",
  cash: "RED",
  reentry: "AMBER",
};

/** The fraction of its gate at which an r4 row tones AMBER ([USER] E5, 2026-07-26). On the
 *  2026-07-26 baseline that paints VIX/VIX3M (0.914 / `R4_VT_TAIL`) amber while dial rung
 *  (4 / `R4_ENTER_RUNG`), families firing (1 / `R4_ENTER_FAMILIES`) and the HY-OAS tail
 *  (2.77 / `R4_HY_TAIL`) stay green. The numerators are that day's measurements; every denominator
 *  is the SYMBOL, so a retune cannot strand a stale ratio here (`indicator-loop.md` §A retune is a ONE-place edit —
 *  the HY one did, at the retired 6.0, until the E8 review caught it 2026-07-31). @internal */
export const R4_PROXIMITY_AMBER = 0.8;

/** r4 row tone — how close THIS row's live value sits to THIS row's gate, superseding the
 *  phase-ladder row tone ([USER] E5, 2026-07-26). Every r4 row is a `value ≥ threshold to enter`
 *  gate (§7 Q3 / plan OQ-1), so `value / threshold` is its proximity, the same fraction the FE's
 *  margin bar already draws.
 *
 *  Deliberately TWO tones, never RED. The ENTER gate is `rung AND breadth AND (HY-OAS tail OR
 *  VIX-term tail)` (`enterCond`, r4.ts), so no single row is an entry on its own: a hot rung or
 *  breadth row is one of two required AND terms, and a hot tail row is one side of the OR that
 *  still needs BOTH AND terms beside it. A RED row would read as "the breaker fired" when at most
 *  part of the gate is met. The floor's own `level` chip stays the single place that says whether
 *  it fired.
 *
 *  A `null` value (feed hiccup — HY-OAS/VT) has no readable proximity and tones GREEN: the row still
 *  renders `n/a vs <gate>` with no margin bar, so the absence is visible without a colour claiming
 *  stress that was never measured. @internal */
export function r4ProximityTone(value: number | null, threshold: number): State {
  if (value === null || threshold === 0) return "GREEN";
  return value / threshold >= R4_PROXIMITY_AMBER ? "AMBER" : "GREEN";
}

/** Cap a member's own RAG to the floor's reachable scale (§5 decision 5): `rate` is WATCH-capped and
 *  can never render a RED cell — a member RED collapses to AMBER there. The RED-capable floors
 *  (credit CRITICAL, r4 CRITICAL, geo WARNING) pass the state through unchanged.
 *
 *  `ew` is DELIBERATELY EXCLUDED ([USER] 2026-07-23): its FLOOR stays WATCH-capped (the load-bearing
 *  D-B safety property in `escalatorFloorBreakdown` — unchanged, and the notify path with it), but a
 *  detector whose own confirmed state is RED now renders RED. Collapsing it read as "the leg is only
 *  amber" for a DB_SMH/DB_XLK sitting past its −8% red cut, which is the opposite of what an
 *  early-warning row is for. Display only: `level`/`cap` on the floor are untouched. */
function capMemberState(state: State, floorId: LabFloorId): State {
  return floorId === "rate" && state === "RED" ? "AMBER" : state;
}

/** The geo floor's count in words — `geo base 2 = 1 manual + 1 auto (BRENT, OVX)` (R9, [USER]
 *  2026-07-31; the auto TERM is `autoFactors`, §11.1 2026-08-01 — see below).
 *  Without it a geo WARNING reads as "someone set a flag", when today's base is one manual flag PLUS
 *  a live market reading (OVX RED). Composed here, server-side, off the SAME addends the cut read
 *  ({@link GeoBasis} out of {@link escalatorFloorBreakdown}) — the FE prints the string and counts
 *  nothing, the `note`-on-r4-rows precedent.
 *
 *  ⚠ Prints the SUM ONLY. The `≥1 ⇒ WATCH` / `≥2 ⇒ WARNING` cuts are DELIBERATELY not restated
 *  ([USER] round-2 ruling, 2026-07-31): the sum plus the floor's own level chip beside it already
 *  answers "why WARNING", and a threshold hand-copied into display copy is the exact drift class the
 *  seam rulings exist to prevent. Addends that are zero are omitted rather than printed as `+ 0`;
 *  an all-zero base has no arithmetic to show and says so in words.
 *
 *  ⚠ The auto term is `autoFactors` (distinct `geoFactor`s), while the parenthetical still names
 *  every lit ID — so `1 auto (BRENT, OVX)` is CORRECT, not a typo: two reads of the oil factor buy
 *  one flag (§11.1). Printing `b.auto.length` here would make the terms stop summing to `b.total`. */
export function formatGeoBasis(b: GeoBasis): string {
  const terms: string[] = [];
  if (b.manual > 0) terms.push(`${b.manual} manual`);
  if (b.auto.length > 0) terms.push(`${b.autoFactors} auto (${b.auto.join(", ")})`);
  // The stand-down dwell, with its progress toward release; a released declared 4 (stage 0) is
  // simply omitted like every other zero addend.
  if (b.hold > 0) terms.push(`${b.hold} stage-hold (dwell ${b.dwell}/${DE_ESCALATION_DAYS})`);
  if (b.stage > 0) terms.push(`${b.stage} stage`);
  return terms.length > 0 ? `geo base ${b.total} = ${terms.join(" + ")}` : `geo base 0 - nothing flagged`;
}

/** The SHORT half of the same sentence — `geo base 4` ([USER] 2026-08-05). The full arithmetic grew
 *  wide enough (three addends plus a two-id parenthetical) to force the floor block wider than every
 *  other floor, so the panel now prints this lead and hangs {@link formatGeoBasis} off a ⓘ footnote.
 *  Composed off the SAME `GeoBasis` — deliberately NOT a prefix the FE slices out of the long form,
 *  which would put a display parser between the engine's sum and the screen. */
function formatGeoBasisLead(b: GeoBasis): string {
  return `geo base ${b.total}`;
}

/**
 * Build the LIVE-ONLY /lab BAND drill-down (`LabBand`, role-split board 2026-07-22) — the read-time
 * recompute of {@link escalatorFloorBreakdown} widened to per-member rows. Co-located with the engine
 * (Stage 2b) so the wire DTO cannot drift from the floor levels the notify path pushes: the handler
 * just calls this and assigns `response.band`, never re-deriving a floor.
 *
 * `pushedBand` is the actual persisted alert level (`AlertRecord.level`) — reused, not recomputed, so
 * the headline `level`/`chain.band` can never disagree with what `run-cycle-push.ts` pushed (the `bandReason`
 * read-off-the-row discipline). `source`/`floors` come from the recompute (there is no persisted
 * per-floor state to read). Pure: no IO, no clock.
 *
 * `dialBand` (R6, [USER] 2026-07-31) is the PRE-FLOOR band the headline was escalated FROM — read off
 * the SAME row as `pushedBand`, same discipline. It is a separate field from `chain.band` on purpose:
 * `chain.band` is the pushed, POST-floor result and equals `level`, so it can never show the gap.
 *
 * Each floor's members (§5): credit → F1/F2 (own confirmed RAG); r4 → the four enter-input rows
 * (rung, families, HY-OAS, VT) carrying live `value`/`threshold` vs their `R4_ENTER_*` gate, each
 * toned by ITS OWN proximity to ITS OWN gate ({@link r4ProximityTone}, [USER] E5 2026-07-26 — the
 * rows no longer share the breaker's phase tone, which moved up to the floor head as
 * `phase`/`phaseState`); geo → the manual-flag summary + each auto GEO-channel reading; rate → the
 * RATE-channel non-confirmers; ew → EVERY present `EARLY_WARN_MEMBERS` detector (DB_SMH/DB_XLK),
 * one row each; coverage → one SYNTHETIC row per coverage-degraded family in `coverageFamilies`
 * (R4, 2026-08-01 — the family, not an indicator, is what is unseen). RAG members carry
 * `cappedState` (RED→AMBER on rate only — `ew` members render their own RED; see `capMemberState`).
 */
export function buildLabBand(
  dial: T1DialResult,
  readings: Reading[],
  geoFlags: number,
  r4Phase: R4Phase,
  pushedBand: AlertLevel,
  // Stage 4: the declared crisis stage. Defaults to the LIVE committed config (the same
  // seam the caller reads `geoFlags` from via loadGeoActiveCount) — NOT 0 — so the /lab
  // BAND recompute keeps matching the floors the cron pushed without an api/ handler edit
  // (the handler is untouched by design; config.json is identical in the same deploy).
  // Tests pass an explicit stage for determinism.
  crisisStage: number = loadGeoInputs().crisisStage,
  // R6 ([USER] 2026-07-31): the PRE-FLOOR dial band, the market read `pushedBand` was escalated
  // FROM. Passed by the handler off the SAME persisted alert row `pushedBand` comes from
  // (`AlertRecord.dialBand`), so the two sides of the escalation sentence can never come from
  // different runs — the `bandReason` read-off-the-row discipline, applied to both ends.
  // Defaults to the raw derivation `computeAlertBandDetail` itself uses (`regimeToBand` on the
  // NOTIFY regime, never the display one) for a dial-less/pre-migration row and for pure-logic
  // callers that persist nothing.
  dialBand: AlertLevel = regimeToBand(dial.notifyRegime),
  // R4 (2026-08-01) — the resolved COVERAGE claim, passed straight through to the breakdown so the
  // /lab recompute and the pushed band read the identical floor. Default `false` ⇒ every existing
  // caller's `LabBand` is byte-identical except for the extra always-OK floor row.
  coverageArmed = false,
  // The panel the coverage claim was made over, used ONLY to NAME the degraded families in the
  // floor's member rows (a display concern — the LEVEL is `coverageArmed` alone, never re-derived
  // here). Type-only import: `families.ts` imports alert-band's types back type-only, so there is
  // no runtime cycle. Default `[]` ⇒ the floor renders with no rows, which is exactly what a
  // coverage floor with nothing to report has to say.
  coverageFamilies: readonly FamilyPanel[] = [],
  // The PERSISTED calm streak (`AlertRecord.geoCalmStreak`), passed by the handler off the same
  // row as `pushedBand` (Stage 3). Default = calm: streak-less callers see no hold, released 4.
  geoCalmStreak: number = DE_ESCALATION_DAYS,
): LabBand {
  const breakdown = escalatorFloorBreakdown(
    readings,
    geoFlags,
    r4Phase,
    dial.fired,
    dial.fastBreakEW,
    crisisStage,
    coverageArmed,
    geoCalmStreak,
  );
  const byFloor = new Map(breakdown.floors.map((f) => [f.id, f]));
  const find = (id: string): Reading | null => readings.find((r) => r.indicator.id === id) ?? null;

  /** RAG member: the signal's own confirmed state, capped to the floor's reach. */
  const rag = (r: Reading, floorId: LabFloorId): LabBandMember => ({
    id: r.indicator.id,
    label: r.indicator.label,
    // The descriptive long name rides beside the short one so the FE hover text carries both
    // (official-short-names step 2). Synthetic rows below (r4 inputs, GEO manual, EW fallback)
    // have no indicator, so they omit it.
    longLabel: r.indicator.longLabel,
    state: r.state,
    cappedState: capMemberState(r.state, floorId),
  });

  // credit — F1, F2 (RED-capable; own confirmed RAG).
  const creditMembers: LabBandMember[] = (["F1", "F2"] as const)
    .map(find)
    .filter((r): r is Reading => r !== null)
    .map((r) => rag(r, "credit"));

  // r4 — the binding enter-input rows, each with its live value vs the R4_ENTER_* gate and a tone
  // derived from how close that value sits to that gate ([USER] E5 — `r4ProximityTone`; a `null`
  // value = the input was unavailable this run, HY-OAS/VT feed hiccup, and tones GREEN). r4 is a
  // RED-capable floor, so there is no cap collapse: `cappedState` equals `state`. The breaker's
  // PHASE rides the FLOOR, not these rows.
  const r4Row = (
    id: string,
    label: string,
    value: number | null,
    threshold: number,
    note: string,
  ): LabBandMember => {
    const tone = r4ProximityTone(value, threshold);
    return { id, label, state: tone, cappedState: tone, value, threshold, note };
  };
  const r4Members: LabBandMember[] = [
    r4Row("r4-rung", "dial rung", dial.targetRung, R4_ENTER_RUNG, `rung ≥ ${R4_ENTER_RUNG} to enter`),
    r4Row(
      "r4-families",
      "families firing",
      dial.leadingFiring + dial.coincidentFiring,
      R4_ENTER_FAMILIES,
      `≥ ${R4_ENTER_FAMILIES} of 5 families firing`,
    ),
    // The two TAIL rows additionally carry their strict-`<` EXIT threshold (small-wins §2, [USER]
    // 2026-08-01 — TOOLTIP ONLY). `LabBandMember.note` reaches exactly one surface: band-panel.js's
    // `memberTitle` folds it into the row's `title=`; `memberRow` never prints it. So the r4 row's
    // rendered text and layout are byte-identical and the thresholds show on hover alone.
    // Both halves of the tail-clear EXIT leg are named on BOTH rows because that leg is an AND over
    // the pair (`exitCond`, src/r4.ts) — a row stating only its own `<` would read as a standalone
    // exit, which is the opposite of the gate. The rung-clear OR-leg is deliberately absent: it is a
    // `≤` test on a row (`r4-rung`) whose own note already states its `≥` enter gate, and §0 scoped
    // this to the strict-`<` thresholds.
    r4Row(
      "r4-hyoas",
      `${HY_OAS_LABEL} tail`,
      find("F1")?.level ?? null,
      R4_HY_TAIL,
      `${HY_OAS_LABEL} ≥ ${R4_HY_TAIL.toFixed(1)}% (tail print) · EXIT leg: ${HY_OAS_LABEL} < ${R4_EXIT_HY.toFixed(1)}% AND VT < ${R4_EXIT_VT.toFixed(2)}`,
    ),
    r4Row(
      "r4-vt",
      "VIX/VIX3M tail",
      find("VT")?.level ?? null,
      R4_VT_TAIL,
      `VT ≥ ${R4_VT_TAIL} (tail print) · EXIT leg: VT < ${R4_EXIT_VT.toFixed(2)} AND ${HY_OAS_LABEL} < ${R4_EXIT_HY.toFixed(1)}%`,
    ),
  ];

  // geo — the manual-flag summary (config.json count, each flag ≈ one non-GREEN) + each auto
  // GEO-channel reading (G1 oil today). RED-capable member scale even though the floor caps at
  // WARNING (§5: geo member states pass through uncapped).
  // The stage row's addend comes off the SAME `GeoBasis` the footnote prints — never re-summed here.
  const gb = byFloor.get("geo")?.geoBasis;
  const stageAdd = gb ? gb.stage + gb.hold : 0;
  const geoMembers: LabBandMember[] = [
    {
      id: "GEO_MANUAL",
      label: "Manual geo flags",
      state: geoFlags >= 1 ? "AMBER" : "GREEN",
      cappedState: geoFlags >= 1 ? "AMBER" : "GREEN",
    },
    {
      id: "GEO_STAGE",
      label: "Declared stage",
      state: stageAdd > 0 ? "AMBER" : "GREEN",
      cappedState: stageAdd > 0 ? "AMBER" : "GREEN",
      note: gb
        ? gb.hold > 0
          ? `adds ${stageAdd} to the geo base - includes the stand-down hold (dwell ${gb.dwell}/${DE_ESCALATION_DAYS})`
          : `adds ${stageAdd} to the geo base`
        : undefined,
    },
    ...readings.filter((r) => r.indicator.channel === "GEO").map((r) => rag(r, "geo")),
  ];

  // rate — the RATE-channel non-confirmers (the exact set `escalatorFloorBreakdown` scores).
  // WATCH-capped: a member RED renders AMBER.
  const rateMembers: LabBandMember[] = readings
    .filter((r) => r.indicator.channel === "RATE" && !r.indicator.confirmer)
    .map((r) => rag(r, "rate"));

  // ew — the EARLY_WARN_MEMBERS downside-break detectors interleaved with their RS_LEG_OF
  // rel-strength siblings (DB_SMH, RS_SMH, DB_XLK, RS_XLK — detector then its leg, 2026-08-15).
  // The FLOOR is WATCH-capped; the member cells are NOT (2026-07-23) — a RED cell renders RED.
  // EVERY present member gets its OWN row, in EARLY_WARN_MEMBERS order (2026-07-23) — the same
  // shape as the `rate` floor. The prior single-worst-member row made a member INVISIBLE whenever
  // a sibling was equal-or-worse (both AMBER in prod ⇒ DB_XLK never rendered), which reads as
  // "the leg isn't wired". When exactly ONE leg of a pair is past its cut, BOTH rows carry a `note`
  // naming the unmet condition — computed HERE because only src knows the pairing; the FE renders
  // it verbatim. Display only: the floor LEVEL is still `earlyWarnFires` (the per-member AND-gate,
  // OR across members), so nothing on the notify path moves. Falls back to the dial's `fastBreakEW`
  // when NO member reading is persisted (pre-detector row, or a run that dropped the price batch)
  // so the row is never empty; the fallback keeps its original DB_SMH identity — no member
  // reading exists to attribute it to.
  const ewMembers: LabBandMember[] = [];
  for (const id of EARLY_WARN_MEMBERS) {
    const det = find(id);
    if (!det) continue;
    const rsId = RS_LEG_OF[id];
    const rs = rsId === undefined ? null : find(rsId);
    const breakPast = det.state !== "GREEN";
    const rsPast = rs === null ? null : rs.state !== "GREEN";
    const note =
      breakPast && rsPast === false
        ? EW_HALF_MET_BREAK
        : !breakPast && rsPast === true
          ? EW_HALF_MET_RS
          : undefined;
    ewMembers.push(note === undefined ? rag(det, "ew") : { ...rag(det, "ew"), note });
    if (rs) ewMembers.push(note === undefined ? rag(rs, "ew") : { ...rag(rs, "ew"), note });
  }
  if (ewMembers.length === 0)
    ewMembers.push({
      id: "DB_SMH",
      label: "SMH fast break",
      state: dial.fastBreakEW ? "AMBER" : "GREEN",
      cappedState: dial.fastBreakEW ? "AMBER" : "GREEN",
    });

  // coverage — SYNTHETIC rows (no indicator behind them), one per coverage-degraded family: the row
  // IS the family whose verdict is resting on data that is not live, so `id` is the FamilyKey and
  // `label` the family's own label. AMBER, never RED: this floor is WATCH-capped and the claim is
  // about SIGHT, not danger. The rows are DISPLAY only — the floor's LEVEL is `coverageArmed`
  // alone, resolved by the caller and never re-derived from this list.
  // The note names BOTH halves of the claim, because `FamilyPanel` now carries both id sets: the
  // dark roster members (`absentIds`) and the present-but-lagging members holding the verdict
  // (`verdictHoldIds`, B4). An EMPTY set is OMITTED — never printed as an empty clause. ⚠ The
  // BOTH-EMPTY case (the bare held-sentence, `clauses.length ? … : held` below) is REACHABLE since
  // Stage C: a CARRIED-ONLY family whose members were all carried IN-CUT has empty `absentIds` and
  // empty `verdictHoldIds` yet is `coverageDegraded` — its whole verdict rests on carried last-known
  // data, exactly what the bare sentence says. (A carried-only family with an aged-out member keeps
  // that id in `absentIds`, so the absent clause prints instead.) No `ageDays` here: this
  // module is param-pure and holds no clock, so age belongs to the run-seam trace, not this note.
  const coverageMembers: LabBandMember[] = coverageFamilies
    .filter((f) => f.coverageDegraded === true)
    .map((f): LabBandMember => {
      const absent = f.absentIds ?? [];
      const verdictHold = f.verdictHoldIds ?? [];
      // DEFENSIVE ONLY — unreachable through `computeFamilyPanel`/`applyFamilyCarry` today: a
      // zero-present-member family is the only `state === null` case, and `computeFamilyPanel`
      // gives it `coverageDegraded: false` while `applyFamilyCarry` re-marks it with a NON-null
      // last-known state. So no row reaching this builder (which filters on `coverageDegraded`)
      // can carry a null state. Kept as a cheap fail-safe: a future producer must still print
      // something honest rather than the string "null".
      const verdict = f.state === null ? "carried" : f.state;
      // Two honest halves, never one blanket "held by non-live data" headline: a LAG member's
      // last-known value really does hold the verdict; an ABSENT member does not — the verdict was
      // computed WITHOUT it (the false-coverage bug this string carried).
      const clauses = [
        ...(verdictHold.length ? [`held by lagging ${verdictHold.join(", ")}`] : []),
        ...(absent.length ? [`computed without ${absent.join(", ")} (not reporting)`] : []),
      ];
      return {
        id: f.key,
        label: f.label,
        state: "AMBER",
        cappedState: "AMBER",
        note: clauses.length
          ? `this family's ${verdict} verdict - ${clauses.join("; ")}`
          : `this family's ${verdict} verdict rests on last-known data`,
      };
    });

  const membersOf: Record<LabFloorId, LabBandMember[]> = {
    credit: creditMembers,
    r4: r4Members,
    geo: geoMembers,
    rate: rateMembers,
    ew: ewMembers,
    coverage: coverageMembers,
  };

  // Rendered in `FLOOR_SOURCES` order — most-severe-first, the binding precedence, matching
  // `breakdown.floors`. Each floor reuses the engine's own computed level + cap (single-sourced).
  const floors: LabBandFloor[] = FLOOR_SOURCES.map((id) => {
    const f = byFloor.get(id)!;
    const base = { id, level: f.level, cap: f.cap, members: membersOf[id] };
    // The breaker's phase rides the r4 FLOOR head ([USER] E5) now that the rows carry proximity
    // instead. Only `r4` has a phase — the other four floors omit both fields.
    if (id === "r4") return { ...base, phase: r4Phase, phaseState: R4_PHASE_TONE[r4Phase] };
    // `geo` alone carries the count arithmetic (R9) — every other floor's level follows from the
    // member rows themselves, so there is no sum to spell out.
    // Two fields, one composition ([USER] 2026-08-05): the LEAD is the on-screen line, the full
    // arithmetic moves into the footnote the FE hangs off its ⓘ. Both come from `geoBasis` here —
    // the FE never slices one out of the other.
    if (id === "geo" && f.geoBasis)
      return { ...base, basis: formatGeoBasisLead(f.geoBasis), basisDetail: formatGeoBasis(f.geoBasis) };
    return base;
  });

  return {
    level: pushedBand,
    dialBand,
    source: breakdown.source,
    chain: { dangerScore: dial.dangerScore, regime: dial.regime, band: pushedBand },
    floors,
  };
}

/**
 * De-escalation lag (decision, N=2). Upgrades (a higher dial band) apply
 * immediately; a downgrade applies only once the lower raw `dialBand` has held for
 * N consecutive runs.
 *
 * Implemented as a sliding-window max over the raw dial band: today's `dialBand`
 * plus the previous `N−1` runs' raw dial bands. A higher current read wins the max
 * instantly (fast up); a lower current read only takes effect once every higher
 * read has fallen out of the N-run window (slow down). This is the plan's
 * `deEscalationLag(dialBand, lastBand, heldRuns)` intent expressed over the raw
 * `dial_band` history the store persists (Stage 3.5) — it needs no separately
 * persisted "previous lagged band" and no under-specified `heldRuns` counter, and
 * it uses the RAW dial band precisely because the persisted `alert_level` is
 * escalator-masked and can't reveal a dropping dial.
 *
 * `recentDialBands` = the persisted raw `dial_band` of prior runs, most-recent
 * first; nulls (pre-migration rows) are dropped by the caller. Only the first N−1
 * are consulted.
 */
export function deEscalationLag(
  dialBand: AlertLevel,
  recentDialBands: AlertLevel[],
  n = DE_ESCALATION_DAYS,
): AlertLevel {
  const window = recentDialBands.slice(0, Math.max(0, n - 1));
  return maxBand(dialBand, ...window);
}

interface AlertBandInput {
  dial: T1DialResult;
  readings: Reading[];
  /** manual-only geo flag count (`loadGeoInputs().flagCount`); auto oil is read off `readings`. */
  geoFlags: number;
  /**
   * Declared GEO crisis stage 0–4 (Stage 4, config.json via `loadGeoInputs`), folded into the
   * geo floor as `STAGE_TO_FLAGS[stage]` extra flags. Optional, default 0 — pure-logic tests,
   * sims and replay probes carry no stage (no replayable stage history, same as `geoFlags`).
   */
  crisisStage?: number;
  /**
   * The persisted GEO calm streak (run-core.ts computes it off `prevDay` + the trigger states),
   * driving the auto stage-1 hold and the declared-4 release. Absent ⇒ calm (no hold, released 4).
   */
  geoCalmStreak?: number;
  r4Phase: R4Phase;
  /** persisted raw `dial_band` of prior runs, most-recent first (nulls pre-dropped). */
  recentDialBands: AlertLevel[];
  /**
   * W4-e Stage 4 — the prior persisted FINAL band, passed by the caller ONLY when ≥1 feed is lagging
   * (it gates on `verdictHoldLegs`). While blind the band cannot step DOWN below it: `band = maxBand(band,
   * verdictHoldFloor)`. A lag-benign leg must not be trusted to have improved the band. Matches the
   * probe's A-A hold definition (prior `computeAlertBandDetail(...).band` = persisted `level`).
   * Undefined ⇒ no hold (no lagging leg, or a pure-logic test).
   */
  verdictHoldFloor?: AlertLevel;
  /**
   * R4/R5 coverage floor (Stage 3.2) — the caller's already-resolved arming claim, produced by
   * {@link coverageArmed} over the run's CARRIED DIAL panel and its readings. A plain boolean on
   * purpose: this module reads no panel, no store and no clock. Optional, default `false` ⇒
   * pure-logic tests, the notify sims and `scripts/simulate-notify.ts` are byte-unchanged.
   */
  coverageArmed?: boolean;
  n?: number;
  /**
   * D-B divergence escalator (Stage 2.2) — the QQQ distance-to-252d-high fraction
   * (`scoreSlow().spDistToHigh`, threaded by `run-cycle-exposure.ts` off the slow track) and the calibrated
   * near-high tolerance (`equity/qqq_nearhigh_tol` read from `getCalibration()`). Both arrive
   * as pure params — alert-band reads NO store. `null` on either (degraded slow feed, or an
   * absent calibration row) ⇒ the divergence bump cannot fire (conservative). See
   * {@link applyDivergenceBump}.
   */
  spDistToHigh?: number | null;
  nearHighTol?: number | null;
}

/**
 * Why the final band is what it is (rank 13 — "make the audit row tell the truth"). Emitted
 * from the actual deciding branch below and persisted on the alert row (`band_reason`), so a
 * WARNING push is reconstructable from /api/history without re-deriving it:
 *   - `floor:<src>` — a hard escalator (credit/geo/r4/rate/ew) raised the band ABOVE the raw dial,
 *                     or `floor:coverage` — the WATCH-capped COVERAGE floor: a family's verdict is
 *                     held by data that is not live, so the band says "we cannot see" (R4). Never a
 *                     market reading, and structurally incapable of exceeding WATCH;
 *   - `lag-hold`    — the de-escalation lag held the band above the (dropping) raw dial;
 *   - `regime`      — the raw dial band stands (no floor, no lag lifted it);
 *   - `verdict-hold` — ≥1 feed is lagging (per cadence) and the prior final band held THIS band above
 *                     where the (possibly lag-benign) dial/floor put it (W4-e Stage 4);
 *   - `no-dial`     — a dial-less run (pure-logic / degraded): band IS the escalator floor,
 *                     and no floor fired (an all-OK floor); a fired floor still reads `floor:<src>`.
 *   - `divergence`  — the D-B escalator bumped the band +1: HY-OAS (F1) 30d Δ > 0 AND QQQ at/above
 *                     its calibrated near-high tolerance (credit widening INTO an equity high). Only
 *                     emitted when the bump actually BOUND (strictly raised the composed band).
 */
const NON_FLOOR_BAND_REASONS = ["regime", "lag-hold", "verdict-hold", "no-dial", "divergence"] as const;

/** The reasons `computeAlertBandDetail` itself can emit — every `NON_FLOOR_BAND_REASONS` member
 *  except `no-dial`, which only `run-core.ts` writes (there is no dial to stand on). The coverage
 *  guard in `alert-band.floors.test.ts` derives its expected arm set from this pair of arrays. */
export const DIAL_RUN_BAND_REASONS = NON_FLOOR_BAND_REASONS.filter((r) => r !== "no-dial");

export type BandReason = (typeof NON_FLOOR_BAND_REASONS)[number] | `floor:${FloorSource}`;

interface AlertBandResult {
  band: AlertLevel;
  reason: BandReason;
}

/** Bands in ascending ALERT_RANK order — the inverse of `ALERT_RANK`, for the +1 divergence step. */
const BAND_BY_RANK: AlertLevel[] = ["OK", "WATCH", "WARNING", "CRITICAL"];

/** One ALERT_RANK step up, saturating at CRITICAL (never overflows the enum). */
function bumpBand(band: AlertLevel): AlertLevel {
  return BAND_BY_RANK[Math.min(ALERT_RANK[band] + 1, ALERT_RANK.CRITICAL)]!;
}

/**
 * D-B divergence escalator (Stage 2.2): a **+1 bump on the composed FINAL band** when HY-OAS
 * (F1) is widening over its 30d window (`delta20 > 0` — F1's `velocityWindow: 30` makes `delta20`
 * the 30d Δ post-Stage-1.2) AND QQQ sits at/above its calibrated near-high tolerance
 * (`spDistToHigh >= nearHighTol`) — credit stress rising INTO an equity high, the classic
 * divergence. `null` on either input (degraded slow feed / absent calibration row) ⇒ no fire.
 *
 * DESIGN (ew-invariant reasoning): this is a RELATIVE bump on the FINAL band, NOT one of
 * `escalatorFloorBreakdown`'s absolute floors — a floor is an absolute lower bound computed
 * without knowledge of the lag-composed band, so a "+1 of the final band" cannot live there. It
 * is shipped as a **bump** (decision wording "nudge +1"), NOT a WATCH-capped floor like `ew`,
 * because it does NOT share `ew`'s hazard: `ew` is a lone fast-break DECOUPLED from credit/rates
 * that must never arm the crisis band from a calm world, so it is structurally WATCH-capped. The
 * divergence is the OPPOSITE — it REQUIRES credit widening (F1 30d Δ > 0), so it cannot fire in a
 * calm-credit world; and being a +1 step it reaches CRITICAL only when the composed band is
 * ALREADY WARNING (from OK it reaches only WATCH), so it never manufactures crisis from calm. The
 * calibrated tolerance (p90, ==1.0 ⇒ an exact fresh 252d high) keeps it rare. The bump composes
 * AFTER the floor/lag/regime reason is set and is emitted (`reason: "divergence"`) ONLY when it
 * strictly raised the band, so the `floor:<src> > lag-hold > regime` precedence is untouched for
 * every non-binding case. Pure.
 */
export function applyDivergenceBump(
  result: AlertBandResult,
  readings: Reading[],
  spDistToHigh: number | null,
  nearHighTol: number | null,
): AlertBandResult {
  // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `delta20` is absent only when F1 carries too little
  // history for a 20d change; no evidence of a RISE means no divergence BUMP, and F1's level path
  // (r4-hyoas / creditBlowout) is untouched, so an absent delta20 cannot silence F1 — it only
  // declines to amplify it.
  const hyRising = (readings.find((r) => r.indicator.id === "F1")?.delta20 ?? 0) > 0;
  const divergence = hyRising && spDistToHigh != null && nearHighTol != null && spDistToHigh >= nearHighTol;
  if (!divergence) return result;
  const bumped = bumpBand(result.band);
  return ALERT_RANK[bumped] > ALERT_RANK[result.band] ? { band: bumped, reason: "divergence" } : result;
}

/**
 * Compose the final ntfy alert band `max(deEscalationLag(dial), escalatorFloor)` AND the reason
 * naming the binding constraint (rank 13). Pure. `computeAlertBand` is the band-only wrapper;
 * both read this ONE derivation so the persisted reason can't drift from the band it explains.
 *
 * Reason precedence: the escalator floor is named whenever it reached the final band and did so
 * ABOVE the raw dial (the floor alone would put the band here — the load-bearing cause); else the
 * lag, if it held the band above the raw dial; else the raw regime stands.
 */
export function computeAlertBandDetail(input: AlertBandInput): AlertBandResult {
  // `coverageArmed` is ALIASED on destructure: the FIELD would otherwise shadow the module-level
  // arming predicate {@link coverageArmed} for the whole function body. Both public names are fixed
  // (the field is the caller's wire, the function is /lab's and run-core's seam), so the collision is
  // resolved locally instead of by renaming either.
  const { dial, readings, geoFlags, crisisStage = 0, geoCalmStreak = DE_ESCALATION_DAYS, r4Phase, recentDialBands, verdictHoldFloor, coverageArmed: coverageFloorArmed = false, n = DE_ESCALATION_DAYS } = input;
  const dialBand = regimeToBand(dial.notifyRegime); // notify-axis
  const laggedBand = deEscalationLag(dialBand, recentDialBands, n);
  const floor = escalatorFloorDetail(readings, geoFlags, r4Phase, dial.fired, dial.fastBreakEW, crisisStage, coverageFloorArmed, geoCalmStreak);
  const band = maxBand(laggedBand, floor.band);

  let reason: BandReason;
  if (floor.source && ALERT_RANK[floor.band] === ALERT_RANK[band] && ALERT_RANK[floor.band] > ALERT_RANK[dialBand]) {
    reason = `floor:${floor.source}`;
  } else if (ALERT_RANK[laggedBand] > ALERT_RANK[dialBand]) {
    reason = "lag-hold";
  } else {
    reason = "regime";
  }

  // D-B divergence escalator — +1 on the composed FINAL band when HY-OAS is widening into a QQQ
  // near-high (see applyDivergenceBump). Composes AFTER the floor/lag/regime reason so it only
  // renames the reason when it actually bound; no-op when either input is null.
  const bumped = applyDivergenceBump({ band, reason }, readings, input.spDistToHigh ?? null, input.nearHighTol ?? null);

  // W4-e Stage 4 — while ≥1 feed is lagging the caller passes `verdictHoldFloor` (the prior final band);
  // the band then cannot step DOWN below it (a lag-benign leg must not be trusted to have improved
  // the band). Final maxBand ⇒ can only LIFT, never lower; when it binds (strictly raises the band)
  // it is the load-bearing cause ⇒ reason "verdict-hold". Applied AFTER the divergence bump so a verdict
  // hold can still only LIFT above the (possibly-bumped) band.
  if (verdictHoldFloor != null && ALERT_RANK[verdictHoldFloor] > ALERT_RANK[bumped.band]) {
    return { band: verdictHoldFloor, reason: "verdict-hold" };
  }
  return bumped;
}

export function computeAlertBand(input: AlertBandInput): AlertLevel {
  return computeAlertBandDetail(input).band;
}
