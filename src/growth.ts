/**
 * Growth pillar — leaf module (G0: persist + expose the existing cross-sectional RS).
 *
 * Purity contract, identical to `src/y1.ts`: this file reads NO store and performs NO I/O.
 * It maps sleeves to `GRS_*` ids and projects a `Map<Sleeve, number | null>` RS into
 * display-only `StoredReading` rows. The cron wiring that fetches closes and calls
 * `computeLegRs` lives in `run-seeds.ts` (`seedGrowthRsOnCron`), not here.
 *
 * `GRS_*` is a CACHE of a pure function of the persisted `LEGP_*` closes (via `computeLegRs`),
 * NOT an independent measurement. It is legal to persist precisely because it is re-derivable
 * from `LEGP_*` at any time; it must never become an input that cannot be recomputed. (Contrast
 * `src/y1.ts`'s "MUST NOT GAIN A PERSISTED COLUMN" invariant, which binds `streak` — path-dependent
 * on an unpersisted decision. RS is not path-dependent, so caching it fabricates nothing.)
 *
 * `GRS_*` is a display-only series like `LEGP_*` / `SB_*`: it is NOT a scored indicator and must
 * never leak into the registry, family tables, or the danger surface. Durable exclusion falsifier
 * (run file-wide, comment lines excluded — it CAN fail because these files carry sibling id literals):
 *
 *   grep -rnE '\bGRS_' src/families.ts src/danger-ladder.ts src/registry.ts public/indicator-desc.js \
 *     | grep -vE ':\s*(\*|//|/\*)'
 *
 * Expected: zero hits.
 */
import { isLiveCell, type SignalCell } from "./danger-cell.js";
import { familyLegWeight, type LegField, type SignalKey } from "./danger-ladder.js";
import { LADDER } from "./families.js";
import { LEG_SLUG, navReadingRow } from "./scoreboard.js";
import type { StoredReading } from "./store.js";
import type { Sleeve } from "./y1.js";

/** Persisted id for one leg's cross-sectional relative-strength cache. Reuses `LEG_SLUG` — there is
 *  no second slug map. */
export function growthRsId(sleeve: Sleeve): string {
  return `GRS_${LEG_SLUG[sleeve]}`;
}

/**
 * Project a per-leg RS map into `GRS_*` rows, one per sleeve with a NON-NULL, FINITE RS.
 *
 * A `null` (or non-finite) RS emits NO ROW — `LegRsResult.rs` documents `null` as "no defensible RS,
 * never zero", so writing a `0` row would fabricate a mid-pack leg. This is the single most important
 * property of the builder. Rows use the display-only `navReadingRow` shape (`delta20: 0`,
 * `rawState`/`state` `GREEN`, `decision: null`).
 */
export function growthRsReadingRows(rs: Map<Sleeve, number | null>, date: string): StoredReading[] {
  const rows: StoredReading[] = [];
  for (const sleeve of LADDER) {
    const v = rs.get(sleeve);
    if (v == null || !Number.isFinite(v)) continue; // null/absent/non-finite ⇒ no row (never a 0 row)
    rows.push(navReadingRow(growthRsId(sleeve), date, v));
  }
  return rows;
}

// ─── G1 — the growth pillar: brand + three-term fold (pure) ─────────────────────────
// A MEAN over live terms, NEVER a worst-of (ADR §3.2): growth measures upside participation, so a
// single weak term must not veto the pillar the way danger's max does.

/** Compile-time scale brand for the growth pillar — a phantom tag mirroring `Sev`/`Danger` in
 *  `src/danger-engine.ts`. Zero runtime cost; a raw number is cast to `Growth` only at the single
 *  construction boundary in `computeLegGrowth`, and the brand is deliberately NOT threaded through
 *  internal signatures. Its whole job is to stop a growth value from being fed to a `Sev`-typed sink
 *  (e.g. `scaledSevBand`) and thereby banded by the danger cuts — growth never enters the danger
 *  scalar (ADR §3.2). */
export type Growth = number & { __scale: "growth" };

/** The registry `SignalKey`s whose cells feed the growth trend term — an EXPLICIT subset, currently
 *  just `uT` (the only viable registry momentum signal per the 2026-07-21 double-counting audit).
 *
 *  ⚠ This is intentionally a standalone constant and NOT a `SUPER_GROUP_OF.uT` reassignment. `uT`
 *  lives in the `CONFIRMING` super-group, and `src/t1dial.ts` derives its within-band positioner from
 *  that map (`familiesOf("CONFIRMING")` → `COINCIDENT` → `coincidentFiring`/`coincidentP`). Reassigning
 *  `SUPER_GROUP_OF.uT` to a `"GROWTH"` value would empty `CONFIRMING`, drop `trend` out of `COINCIDENT`,
 *  and MOVE the dial's ● and the emitted band — a notify-visible change and a direct ADR §3.2 violation.
 *  The growth fold gives the `uT` cells a SECOND reader; it never moves them. Same defensive idiom as
 *  `CONFIRMING_TREND_MEMBERS` (an explicit subset so membership can't silently re-acquire veto power). */
const GROWTH_SIGNALS: readonly SignalKey[] = ["uT"];

/** Weight of the cross-sectional relative-strength (RS) term in the growth fold.
 *
 *  Set for EQUAL average contribution of the three fold terms, MEASURED at implementation from the
 *  trend term's `familyLegWeight("uT", sleeve)` magnitudes.
 *
 *  ⚠ RE-MEASURED 2026-08-02 AT THE `uT` `GT` SEAT; THE CONSTANT IS DELIBERATELY NOT RETUNED.
 *  A ruling seated `MEMBER_WEIGHT.GT` on `Health` (0.4) and
 *  `Staples` (0.3) with the coupled `FAMILY_LEG_WEIGHT.uT` 0.9/0.9. That was the edit this docblock was
 *  waiting on, and it collapses the two competing bases it used to have to carry:
 *
 *   • **THE TWO BASES ARE NOW ONE POPULATION.** `FAMILY_LEG_WEIGHT.uT` declares all nine legs, so the
 *     declared-row mean and the actually-summed mean are measured over the same set. There is no longer
 *     any leg where the trend term is summed without a declared entry, which is what made a
 *     "do not pick by convenience" warning necessary — that warning is RETIRED, not merely dropped.
 *   • **MEASURED MEAN = 0.944444** = mean of `familyLegWeight("uT", sleeve)` over all nine legs,
 *     {Semis 1.0, S&P IT 0.9, EM 0.9, Value 1.0, S&P 500 1.0, ex-US 1.0, EU-Fin 0.9, Health 0.9,
 *     Staples 0.9} = 8.5 / 9. Re-derive it from the table, never copy this figure forward.
 *
 *  ⚠ The pre-seat 0.9556 basis was wrong: the pre-seat fold summed only the 7 declared legs (0.942857),
 *  measured at three prod closes 2026-08-02 (`computeLegGrowth(…Health|Staples…).live === false`).
 *
 *  **RULING: record, do not retune** (USER RULING
 *  "record now, retune later"). `GROWTH_MOM_WEIGHT` is defined as equal to this constant for the same
 *  equal-contribution reason, so moving 0.95 → 0.9333 would move BOTH growth-fold terms on ALL NINE
 *  legs — an unrelated behavioural change bundled into a seating commit. So, stated plainly rather than
 *  left overstated: **0.95 is no longer exactly the equal-contribution value**; the equal-contribution
 *  value is 0.944444 and the constant is retained above it pending its own commit. The retune is
 *  ACCEPTED IN PRINCIPLE and filed in `docs/backlog.md` with the three duties it owes (move both
 *  constants together, a growth-fold before/after on all nine legs, re-measure the mean at that commit).
 *  Methodological, never tuned against a replay. */
const GROWTH_RS_WEIGHT = 0.95;

/** Weight of the volatility-adjusted momentum term in the growth fold. Equal to `GROWTH_RS_WEIGHT` for
 *  the same equal-contribution reason (see that constant's measurement). Methodological, not fitted. */
const GROWTH_MOM_WEIGHT = 0.95;

/** Winsorize a cross-sectional z-score at ±3 and linear-scale into [0,1] — the MSCI-Momentum
 *  convention (§0b D1), a documented cap and NOT a fitted knob. `computeLegRs`/`computeVolAdjMom`
 *  standardize to sd≈1 by construction, so ±3 spans the whole nine-leg cross-section bar the extremes.
 *  Pins: `+3 → 1.0`, `−3 → 0.0`, `0 → 0.5`. */
function winsorZ(z: number): number {
  return Math.min(1, Math.max(0, (z + 3) / 6));
}

/**
 * One leg's growth pillar: a WEIGHTED MEAN over up to three live terms —
 *   1. Trend — per `GROWTH_SIGNALS` (=`["uT"]`) cell: `1 − wsev`, weight `familyLegWeight(family, sleeve)`.
 *      A `!isLiveCell(c)` cell (`na`/`insensitive`) is EXCLUDED from BOTH the numerator and the weight
 *      sum (never imputed). ⚠ `wsev === null` is NOT the test: since OQ-5 Stage 5.3
 *      a FULLY-UNOBSERVED measured cell is also `wsev: null`, and that one stays INCLUDED, folded at
 *      its pre-5.3 `1 − 0` (the A2 seam — see `isLiveCell` in `danger-cell.ts`).
 *   2. RS — `winsorZ(rs)`, weight `GROWTH_RS_WEIGHT`. A `null` `rs` is EXCLUDED from both sums (never
 *      read as 0 or 0.5) — `LegRsResult.rs` documents `null` as "no defensible RS".
 *   3. Vol-adj momentum — `winsorZ(mom)`, weight `GROWTH_MOM_WEIGHT`. A `null` `mom` is EXCLUDED the
 *      same way.
 *
 * `value = Σ(w · term) / Σ w`, cast to `Growth` at that single construction boundary. Zero surviving
 * terms ⇒ `{ value: 0 as Growth, live: false }` — the caller drops a non-live pillar entirely rather
 * than treating it as calm. MEAN, never worst-of.
 *
 * TWO liveness flags, deliberately NOT interchangeable:
 *  - `live` — ANY term contributed (`den > 0`). A trend-only fold (both `rs` and `mom` null) is `live`.
 *  - `rsMomLive` — the CROSS-SECTIONAL terms actually contributed: `rs !== null || mom !== null`. It is a
 *    POSITIVE statement about which terms entered the sums, never an inference from `value`.
 *    ⚠ No production code reads it since `pickHeld`'s retired G2.2 growth tiebreak (Rung 4 Stage 2,
 *    2026-08-03) had its window arm deleted; that tiebreak read THIS one, not `live`, because
 *    the trend term alone sets `live`, and a trend-only fold is the same `uT` read that already feeds
 *    the share arm's trend term — letting it win would double-count a danger input as growth evidence.
 */
export function computeLegGrowth(
  cells: SignalCell[],
  leg: LegField,
  rs: number | null,
  mom: number | null,
): { value: Growth; live: boolean; rsMomLive: boolean } {
  let num = 0;
  let den = 0;

  // Trend term(s) — one per GROWTH_SIGNALS cell; a cell carrying no severity (`!isLiveCell`) is
  // excluded from both sums.
  for (const c of cells) {
    if (!GROWTH_SIGNALS.includes(c.family)) continue;
    // OQ-5 Stage 5.3 (Option A2): `isLiveCell`, not a bare
    // `wsev === null`. Since 5.3 a FULLY-UNOBSERVED measured cell also carries `wsev: null`, and
    // dropping it here would be wire-visible — the served growth on a leg whose `uT` cell reported
    // nothing would change (`api/lab.test.ts` G1 "the trend term is live on every leg" is the pin).
    // A2 stops the null at the aggregator: `na`/`insensitive` stay EXCLUDED, the
    // fully-unobserved cell keeps its pre-5.3 fold at 0.
    if (!isLiveCell(c)) continue; // no severity carried (na/insensitive) — never imputed
    const w = familyLegWeight(c.family, leg.sleeve);
    num += w * (1 - (c.wsev ?? 0));
    den += w;
  }

  // RS term — null excluded from both sums.
  if (rs !== null) {
    num += GROWTH_RS_WEIGHT * winsorZ(rs);
    den += GROWTH_RS_WEIGHT;
  }

  // Vol-adj momentum term — null excluded from both sums.
  if (mom !== null) {
    num += GROWTH_MOM_WEIGHT * winsorZ(mom);
    den += GROWTH_MOM_WEIGHT;
  }

  // POSITIVE record of what contributed — read off the same `!== null` conditions the two terms are
  // gated on above, never re-derived from `value`/`den`.
  const rsMomLive = rs !== null || mom !== null;

  if (den === 0) return { value: 0 as Growth, live: false, rsMomLive };
  return { value: (num / den) as Growth, live: true, rsMomLive };
}
