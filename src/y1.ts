/**
 * Y1 relative-strength pick — which leg INSIDE the danger band's licensed range to hold.
 *
 * R1/R4 answer "how defensive"; R5 answers "how much"; Y1 answers "which of the rungs danger
 * already permits". It reads only the nine `LEGP_*` close series and never widens the band: the
 * candidate set is `[band.lo, min(R1_FLOOR_RUNG, band.hi + Y1_REACH)]`, so the pick may reach
 * `Y1_REACH` rung(s) MORE defensive than the band's defensive edge and can never go more aggressive
 * than `band.lo` (D4). Danger's cap on aggression is inviolable to the RS pick.
 *
 * ⚠ DISPLAY-ONLY, and — the load-bearing invariant of this stage — **Y1 MUST NOT GAIN A PERSISTED
 * COLUMN.** Its entire input is persisted series, so `streak` is RECOMPUTED by truncating those
 * series and re-running `computeLegRs` at each of the last `Y1_PERSIST` closes; that is the
 * deliberate contrast with R4, which is path-dependent on an UNPERSISTED decision and therefore
 * genuinely needs its three columns. **Y1-pick-leak falsifier:**
 * `grep -nE '\bcomputeY1\b|\bY1_(REACH|MARGIN|PERSIST|MAX_SPAN_DAYS)\b' src/run-*.ts` → zero hits
 * (verified 2026-10-25). It names the PICK machinery ONLY. The broader `grep -nE '\by1\.js|\bY1_[A-Z]'
 * src/run-*.ts` NO LONGER returns zero (it did through 2026-07-18): growth's `seedGrowthRsOnCron`
 * (growth-pillar Stage 0.2) legitimately reuses this module's RS ENGINE — `computeLegRs, Y1_MIN_OBS,
 * Y1_MIN_LEGS` (ADR ruling 2: "G0 REUSES `computeLegRs`") — so the broad form now hits the `run-seeds.ts`/`run-cycle-exposure.ts`
 * imports plus the `seedGrowthRsOnCron` body/docblock (all known-good). The RS
 * engine is shared infra; the load-bearing INVARIANT is that Y1's PICK (`computeY1` and its
 * `Y1_REACH`/`Y1_MARGIN`/`Y1_PERSIST`/`Y1_MAX_SPAN_DAYS` knobs) never enters the cron/persist path —
 * exactly what the narrowed grep above guards, and non-vacuously: those symbols exist and an import of
 * any of them would hit it. The naive `grep -rn "y1\|Y1_" supabase/migrations/ src/run-*.ts` remains
 * DEFECTIVE and must not be used: the `supabase/migrations/` half is VACUOUS by construction (a `.sql`
 * file cannot contain a TS symbol — the same trap `r5.ts` documents), and a bare `y1\|Y1_` also matches
 * the unrelated `y10` gilt-yield code in `run-cycle-feeds.ts`. Plus the import property: this module
 * imports no store, performs no I/O, and holds no persisted state.
 *
 * Pure leaf: same closes → same result.
 *
 * ── THREE CORRECTIONS to the plan spec, implemented here deliberately ──
 *
 * **(1) A lag/contiguity gate the spec omits.** Stage 3.1 writes `LEGP_*` rows inside
 * `degrade()`'s starve-first tail, so multi-day gaps are the EXPECTED failure mode, not a freak one.
 * An ungated 252-day lookback over a gappy series reads a multi-week move as a single return and
 * paints a live pick with no degrade marker. `Y1_MAX_SPAN_DAYS` gates the INTERSECTED axis (see (2)),
 * not each leg separately — the axis is what every lookback is indexed off, so it is the only span
 * that can distort a return.
 *
 * **(2) Alignment is by DATE-INTERSECTION, not per-leg indexing.** The spec indexes `P(t)/P(t−L)`
 * off each leg's own series, but six legs trade Xetra/LSE and three trade US: leg A's `t−63` is a
 * different calendar date than leg B's, so a cross-sectional z over per-leg indices compares
 * different periods. Instead ONE shared date axis is built = the intersection of the dates present
 * across the legs under consideration, sorted ascending; every lookback indexes off THAT axis. A leg
 * missing a close on an axis date is excluded from the axis — that is what intersection means, and
 * it is by design, not an error. Assuming nine rows per date is a bug: `asOf` follows whichever venue
 * closed latest.
 *
 * **(3) Y1 consumes LEVELS, not chained ratios — deliberately, with a documented exposure.**
 * `LEGP_*` levels are vintage-mixed: `fetchDailyCloses` returns `adjClose`, back-adjusted as of the
 * fetch date (mechanism: the "Vintage note" docblock in `src/r5.ts` — not re-derived here). Persisting
 * a chained ratio per leg instead would be a Stage-3 PERSISTENCE change, out of Stage 5's scope, so
 * levels are kept and the exposure is recorded rather than solved:
 *   (a) unlike R5's single-leg window, Y1's CROSS-SECTIONAL rank is **not immune even to a one-shot
 *       seed** — the total-return-vs-price-only basis differs BY LEG, so high-yield legs (`LEGP_EUFIN`
 *       worst, ~4%/yr) are systematically UNDER-ranked against low-yield growth legs;
 *   (b) the ops rule that bounds it: **never RE-RUN `npm run backfill -- legs` once cron rows have
 *       accumulated** — insert-missing leaves the old rows on their stale basis and freezes a seam;
 *       delete-and-reseed instead;
 *   (c) the durable fix, if this ever matters enough to pay for: persist a chained ratio per leg.
 * This is a documented KNOWN BIAS, not a solved problem. It biases the level of every leg's RS, not
 * just the noise.
 *
 * Constants are METHODOLOGICAL (a convention, a structural bound, or a symmetry) — none is fitted to
 * a replayed world ("no backtest as arbiter"). All seven are
 * pinned by `y1.test.ts`.
 */

import { LADDER } from "./families.js";
import { R1_FLOOR_RUNG } from "./r1.js";
import type { SeriesPoint } from "./store.js";

/** A ladder sleeve name; its rung is `LADDER.indexOf(sleeve) + 1` (1-based, HIGHER = MORE defensive,
 *  matching `prevTargetOf` in `src/lab-assembly.ts`). */
export type Sleeve = (typeof LADDER)[number];

/** Lookback windows in AXIS OBSERVATIONS (see correction (2)), evaluated as an ensemble and reduced
 *  by mean — never a single lookback (the §4.3 parameter-fragility trap). 3/6/12-month trading-day
 *  equivalents: the standard momentum ensemble, three points spanning the horizon where the
 *  relative-momentum edge is documented (and decays by 10–12mo). Pinned by `y1.test.ts` "dropping one
 *  lookback's data still produces an RS from the surviving two, and SAYS so" — which asserts the
 *  reported `lookbacksUsed`, not merely that some number came out (a `typeof === "number"` assertion
 *  cannot tell two survivors from one, which is the degrade this constant exists to make visible). */
export const Y1_LOOKBACKS = [63, 126, 252] as const;

/** Minimum observations before a leg may enter the cross-section, = `max(Y1_LOOKBACKS) + 1`: the
 *  longest lookback needs L+1 closes to yield L returns. Pinned by `y1.test.ts` "252 observations ⇒
 *  null RS, 253 ⇒ a number". */
export const Y1_MIN_OBS = Math.max(...Y1_LOOKBACKS) + 1;

/** A cross-sectional z over fewer than three legs is not a cross-section — it is a comparison. A
 *  lookback that cannot muster this many qualifying legs is DROPPED entirely, never zero-filled
 *  (zero-filling would fabricate an "average" leg that no series supports). TWO distinct sites enforce
 *  this and they need SEPARATE pins: the early return at `eligible.length < Y1_MIN_LEGS` (too few legs
 *  have enough history at all — pinned by `y1.test.ts` "fewer than Y1_MIN_LEGS legs with enough
 *  history ⇒ all-null"), and the per-lookback `scores.size < Y1_MIN_LEGS` drop (enough eligible legs
 *  overall, but too few can be SCORED on one particular window — pinned by `y1.test.ts` "a lookback
 *  only 2 legs can be scored on is dropped, while the other lookbacks still yield an RS"). The second
 *  is the reachable-in-production one: a leg eligible by row count can still fail `vol > 0` on a flat
 *  window. */
export const Y1_MIN_LEGS = 3;

/** D4's "one leg below the band floor" — how far MORE DEFENSIVE than `band.hi` the pick may reach.
 *  There is no symmetric aggression reach: `band.lo` is a hard ceiling on aggression. Pinned by
 *  `y1.test.ts` "the candidate set never contains a rung below band.lo and never exceeds band.hi +
 *  Y1_REACH". */
export const Y1_REACH = 1;

/** Switch bar, in cross-sectional standard deviations. Half an sd is the "much-stronger" gate: large
 *  enough that ordinary cross-sectional noise cannot trip it, small enough that a genuine leader
 *  clears it. Two-sided — the same bar is required to switch BACK, which is what stops chatter.
 *  First-cut, eyeball-tunable. Pinned by `y1.test.ts` "a 0.49 gap does not switch, 0.50 does". */
export const Y1_MARGIN = 0.5;

/** Consecutive closes the margin must hold before the pick switches. One trading week — far longer
 *  than any indicator confirm tier (`CONFIRM_TIERS` is 2, and DOWN-only: escalation is instant,
 *  so the indicator layer buys no delay on the way up) because the momentum-crash failure mode is worst on fast
 *  reversals; this is the only brake on the pick. Pinned by `y1.test.ts` "a 4-close streak holds the incumbent, a 5-close
 *  streak switches". */
export const Y1_PERSIST = 5;

/** Lag bound on the INTERSECTED axis, stated for a FULL `Y1_MIN_OBS`-date axis: those 253
 *  newest dates must span no more calendar days than this, or Y1 degrades to all-null instead of
 *  ranking. Applied PRO-RATA when the axis is shorter than `Y1_MIN_OBS` — the gate is really a bound
 *  on calendar days PER AXIS OBSERVATION (`Y1_MAX_SPAN_DAYS / Y1_MIN_OBS` ≈ 2.06 days/close), and the
 *  gated window is `axis.slice(-Y1_MIN_OBS)`, which on a short axis is the whole axis. Without the
 *  pro-rata scaling the gate does not bind at all below 253 dates: a 64-date axis spanning 500
 *  calendar days (~8 days per "daily" close — a near-dead feed after a starved-cron stretch) would
 *  pass at `500 <= 520`, the 63-lookback would run, and `dailyVol` would read 8-day moves as daily
 *  returns while Y1 painted a live pick with NO degrade marker — exactly what this gate exists to
 *  prevent. ASYMMETRY WITH R5, deliberate: `r5.ts` needs no such scaling because it FLOORS FIRST
 *  (returns warming-up below `R5_MIN_OBS` at `r5.ts:163`, before the span check at `:187`), so its
 *  gate always sees exactly `R5_MIN_OBS` closes. Y1 cannot floor first — it ranks off whatever
 *  lookbacks the axis supports, so its gated window is variable-length and the bound must scale with
 *  it. Same rationale as
 *  `R5_MAX_SPAN_DAYS`, re-derived for this horizon: 252 trading days normally span ~366 calendar
 *  days, R5 allows ~1.43× slack over its expected span (120 vs ~84), and 520/366 ≈ 1.42 matches it —
 *  generous enough that holiday-heavy stretches and the three venue calendars the nine legs trade on
 *  never trip it, tight enough that a genuinely dark multi-week stretch does. ONE-SIDED-VERIFIABLE
 *  (too small degrades spuriously, too large is silent), which is why it is set generous rather than
 *  tight. Methodological, not fitted. Pinned by `y1.test.ts` "an axis spanning more than
 *  Y1_MAX_SPAN_DAYS degrades; at the bound it computes" and, for the pro-rata half, "a short axis is
 *  gated pro-rata — 64 dates over 500 days degrades". */
export const Y1_MAX_SPAN_DAYS = 520;

/** Ties in RS below this are treated as equal, and the MORE DEFENSIVE (higher) rung wins —
 *  deterministic and fail-safe-directional. No lexicographic fallback is needed: each rung maps to
 *  exactly one leg. */
const RS_TIE_EPSILON = 1e-9;

const MS_PER_DAY = 86_400_000;

/** Calendar days between two ISO `YYYY-MM-DD` dates, or null if either is unparseable. Parsed as UTC
 *  so a DST boundary cannot shift the difference off an integer. (Deliberately duplicated from
 *  `r5.ts` rather than extracted: both are pure leaves and the repo bans N=2 abstractions.) */
function spanDays(first: string, last: string): number | null {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / MS_PER_DAY;
}

/**
 * Sample stdev of the daily log returns implied by `closes` — NOT annualized. The cross-sectional
 * standardization downstream makes any constant scale factor cancel, so annualizing would be noise.
 *
 * Returns null when the input cannot support a stdev: fewer than two returns, or any non-finite /
 * non-positive close (a log return is undefined there, and dropping such a point would splice two
 * non-adjacent dates into one bogus return).
 */
function dailyVol(closes: number[]): number | null {
  if (closes.length < 3) return null; // need ≥2 returns for a sample stdev
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    if (!(prev > 0) || !(curr > 0) || !Number.isFinite(prev) || !Number.isFinite(curr)) return null;
    returns.push(Math.log(curr / prev));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (returns.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  return Math.sqrt(variance);
}

export interface LegRsResult {
  /** One entry for EVERY `LADDER` sleeve; `null` means "no defensible RS", never zero. */
  rs: Map<Sleeve, number | null>;
  /** How many of `Y1_LOOKBACKS` actually contributed, 0–3. Surfaced rather than left implicit
   *  because a short axis silently drops the long lookbacks (`axis.length < lookback + 1`) and an RS
   *  built from ONE lookback still prints a perfectly ordinary `margin` — the §4.3
   *  parameter-fragility trap that `Y1_LOOKBACKS` exists to avoid, arrived at by degrade instead of
   *  by choice. Reporting it lets `/lab` show a one-lookback RS as visibly weaker. */
  lookbacksUsed: number;
}

/**
 * Relative strength per leg: ensemble-lookback, vol-scaled, cross-sectionally standardized.
 *
 * `legSeries` maps each sleeve to its `LEGP_*` closes oldest→newest, exactly as `store.getSeries`
 * returns them. The result's `rs` carries an entry for EVERY `LADDER` sleeve; `null` means "no
 * defensible RS" (starved leg, degraded axis, or every lookback dropped) and must never be read as
 * zero. `lookbacksUsed` reports how many lookbacks survived, so a degraded single-lookback RS is
 * distinguishable from the full ensemble.
 *
 * Four steps, per lookback `L ∈ Y1_LOOKBACKS`, all indexed off the shared intersected axis:
 *   1. raw return `r_L = P(t)/P(t−L) − 1` on the EUR closes Stage 3.1 persists (currency-neutralized
 *      at the source — this is why RS is not an FX signal);
 *   2. vol-scale within the same window, `s_L = r_L / stdev(daily log returns over the window)`;
 *   3. cross-sectionally standardize `s_L` across the qualifying legs; fewer than `Y1_MIN_LEGS`
 *      qualifiers (or a degenerate zero cross-sectional sd) drops the lookback entirely;
 *   4. `RS(leg) = mean(z_L)` over the surviving lookbacks.
 */
export function computeLegRs(legSeries: Map<Sleeve, SeriesPoint[]>): LegRsResult {
  const out = new Map<Sleeve, number | null>();
  for (const sleeve of LADDER) out.set(sleeve, null);
  const degraded: LegRsResult = { rs: out, lookbacksUsed: 0 };

  // A leg enters the cross-section only with a full longest-lookback history of its own.
  const eligible = LADDER.filter((s) => (legSeries.get(s)?.length ?? 0) >= Y1_MIN_OBS);
  if (eligible.length < Y1_MIN_LEGS) return degraded;

  const byDate = new Map<Sleeve, Map<string, number>>();
  for (const sleeve of eligible) {
    const m = new Map<string, number>();
    for (const p of legSeries.get(sleeve) ?? []) {
      if (Number.isFinite(p.value) && p.value > 0) m.set(p.date, p.value);
    }
    byDate.set(sleeve, m);
  }

  // Correction (2): ONE shared axis = the date intersection across the eligible legs.
  const seed = byDate.get(eligible[0] as Sleeve) as Map<string, number>;
  const axis = [...seed.keys()]
    .filter((d) => eligible.every((s) => (byDate.get(s) as Map<string, number>).has(d)))
    .sort();

  const shortest = Math.min(...Y1_LOOKBACKS);
  if (axis.length < shortest + 1) return degraded;

  // Correction (1): gate the axis, not each leg. Only the newest `Y1_MIN_OBS` dates can ever be
  // consulted, so that is the stretch whose contiguity matters.
  // The bound is PRO-RATA in the gated window's length (see `Y1_MAX_SPAN_DAYS`): on a short axis
  // `gated` is the whole axis, and a bound calibrated for 253 dates would not bind at all.
  const gated = axis.slice(-Y1_MIN_OBS);
  const span = spanDays(gated[0] as string, gated[gated.length - 1] as string);
  const bound = (Y1_MAX_SPAN_DAYS * gated.length) / Y1_MIN_OBS;
  if (span == null || span > bound) return degraded;

  const zSum = new Map<Sleeve, number>();
  const zCount = new Map<Sleeve, number>();
  let lookbacksUsed = 0;

  for (const lookback of Y1_LOOKBACKS) {
    if (axis.length < lookback + 1) continue;
    const window = axis.slice(-(lookback + 1));

    const scores = new Map<Sleeve, number>();
    for (const sleeve of eligible) {
      const m = byDate.get(sleeve) as Map<string, number>;
      const closes = window.map((d) => m.get(d) as number);
      const start = closes[0] as number;
      const end = closes[closes.length - 1] as number;
      const vol = dailyVol(closes);
      if (vol == null || !(vol > 0) || !(start > 0)) continue;
      const scaled = (end / start - 1) / vol;
      if (Number.isFinite(scaled)) scores.set(sleeve, scaled);
    }

    if (scores.size < Y1_MIN_LEGS) continue; // dropped, never zero-filled

    const values = [...scores.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
    const sd = Math.sqrt(variance);
    if (!Number.isFinite(sd) || !(sd > 0)) continue; // degenerate cross-section

    lookbacksUsed++;
    for (const [sleeve, value] of scores) {
      zSum.set(sleeve, (zSum.get(sleeve) ?? 0) + (value - mean) / sd);
      zCount.set(sleeve, (zCount.get(sleeve) ?? 0) + 1);
    }
  }

  for (const sleeve of eligible) {
    const n = zCount.get(sleeve) ?? 0;
    if (n > 0) out.set(sleeve, (zSum.get(sleeve) as number) / n);
  }
  return { rs: out, lookbacksUsed };
}

/** Fast momentum lookback in trading days for the volatility-adjusted momentum estimator (§0b D3).
 *  METHODOLOGICAL, not fitted: 63d ≈ one quarter, the short horizon where the vol-adjusted momentum
 *  edge is documented. A SINGLE fixed lookback (unlike `computeLegRs`'s 3/6/12mo ensemble) — this
 *  estimator is deliberately fast to complement, not duplicate, RS. Pinned by `y1.test.ts`. */
const VAM_LOOKBACK = 63;

/** Most-recent trading days SKIPPED before measuring momentum (§0b D3, the "X−1" skip that avoids
 *  blow-off tops — the 1-month reversal the momentum literature excludes). METHODOLOGICAL. */
const VAM_SKIP = 5;

/** Minimum closes a leg needs to yield a defined `volAdjMom` = `VAM_SKIP + VAM_LOOKBACK + 1` = 69:
 *  the oldest close consulted is `close[t − VAM_SKIP − VAM_LOOKBACK]`, so its index `n − 69` must be
 *  ≥ 0. A leg with fewer closes → `null`, EXCLUDED (never imputed), exactly like `computeLegRs`. */
export const VAM_MIN_OBS = VAM_SKIP + VAM_LOOKBACK + 1;

interface VolAdjMomResult {
  /** One entry for EVERY `LADDER` sleeve; `null` means "no defensible vol-adj momentum" (starved leg,
   *  degenerate realized vol, or a degenerate cross-section), never zero — mirrors `LegRsResult.rs`. */
  mom: Map<Sleeve, number | null>;
  /** How many legs carry a DEFINED (non-null) `volAdjMom` in the returned cross-section, 0–9. Unlike
   *  `LegRsResult.lookbacksUsed` (which counts surviving lookbacks of an ensemble) this estimator uses
   *  a single fixed lookback, so the parallel "how much survived" degrade signal is the number of legs
   *  that cleared the history + realized-vol guards and thus entered the standardized cross-section. 0
   *  whenever the cross-section is degenerate (fewer than `Y1_MIN_LEGS` defined legs, or zero
   *  cross-sectional sd), in which case every entry in `mom` is `null`. */
  lookbacksUsed: number;
}

/**
 * Volatility-adjusted short-horizon momentum per leg, cross-sectionally standardized (§0b D3).
 *
 * `legSeries` maps each sleeve to its `LEGP_*` closes oldest→newest — the SAME input shape as
 * `computeLegRs` (the /lab caller passes the one close-series map, never fetching closes twice). The
 * result's `mom` carries an entry for EVERY `LADDER` sleeve; `null` means "no defensible value" and
 * must never be read as zero. This function returns the RAW cross-sectional z-score; the ±3 winsorize
 * and [0,1] map live in `growth.ts`'s fold (`winsorZ`), NOT here.
 *
 * Per leg, off that leg's own series (t = newest close):
 *   1. `mom = close[t − VAM_SKIP] / close[t − VAM_SKIP − VAM_LOOKBACK] − 1` — a fast return skipping
 *      the most recent `VAM_SKIP` days; a leg with < `VAM_MIN_OBS` closes → `null`;
 *   2. `realizedVol` = sample stdev of daily log returns over the same `VAM_LOOKBACK`-day window
 *      (`dailyVol`); zero / non-finite realized vol → `null`;
 *   3. `volAdjMom = mom / realizedVol`.
 * Then cross-sectionally standardize the defined `volAdjMom` values to mean 0 / sd 1 (the same idiom
 * as `computeLegRs`); `null` legs are excluded from the mean/sd and stay `null`. Fewer than
 * `Y1_MIN_LEGS` defined legs — or a degenerate (zero) cross-sectional sd — is not a cross-section: all
 * `null` (a 2-leg z-score is a constant ±0.707, so RS's ≥3 floor is mirrored here, §0c).
 */
export function computeVolAdjMom(legSeries: Map<Sleeve, SeriesPoint[]>): VolAdjMomResult {
  const out = new Map<Sleeve, number | null>();
  for (const sleeve of LADDER) out.set(sleeve, null);
  const degraded: VolAdjMomResult = { mom: out, lookbacksUsed: 0 };

  // Per-leg raw vol-adjusted momentum, off each leg's own series (no shared axis: each leg yields a
  // single scalar, and the cross-section standardizes those scalars).
  const raw = new Map<Sleeve, number>();
  for (const sleeve of LADDER) {
    const series = legSeries.get(sleeve);
    if (series == null || series.length < VAM_MIN_OBS) continue; // starved ⇒ null (excluded)

    const closes = series.map((p) => p.value);
    const n = closes.length;
    const endIdx = n - 1 - VAM_SKIP; // close[t − VAM_SKIP]
    const startIdx = endIdx - VAM_LOOKBACK; // close[t − VAM_SKIP − VAM_LOOKBACK]
    const start = closes[startIdx] as number;
    const end = closes[endIdx] as number;
    if (!(start > 0) || !(end > 0) || !Number.isFinite(start) || !Number.isFinite(end)) continue;

    // Realized vol over the SAME window: the VAM_LOOKBACK+1 closes spanning the momentum measurement.
    const window = closes.slice(startIdx, endIdx + 1);
    const vol = dailyVol(window);
    if (vol == null || !(vol > 0)) continue; // degenerate realized vol ⇒ null (excluded)

    const volAdjMom = (end / start - 1) / vol;
    if (Number.isFinite(volAdjMom)) raw.set(sleeve, volAdjMom);
  }

  // Cross-sectional standardization over the DEFINED legs (mirror `computeLegRs`, §0c "mirror RS
  // exactly"). Floor at `Y1_MIN_LEGS` like RS, NOT 2: a two-value z-score is always ±0.707 whatever
  // the momenta (the winsorized fold then emits a constant {0.618, 0.382}), so a 2-leg cross-section
  // carries only sign, no dispersion — degenerate exactly as RS's own floor rejects.
  if (raw.size < Y1_MIN_LEGS) return degraded; // fewer than Y1_MIN_LEGS defined ⇒ not a cross-section
  const values = [...raw.values()];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  if (!Number.isFinite(sd) || !(sd > 0)) return degraded; // degenerate cross-section ⇒ all null

  for (const [sleeve, value] of raw) out.set(sleeve, (value - mean) / sd);
  return { mom: out, lookbacksUsed: raw.size };
}

/** The danger band's rung range, 1-based over `LADDER` (`lo` = most aggressive licensed rung). */
interface Y1Band {
  lo: number;
  hi: number;
}

interface Y1Result {
  /** The rung to hold: the challenger once the gate clears, else the (clamped) incumbent. `null`
   *  only if the candidate set is empty, which the clamping makes unreachable in practice. */
  pickRung: number | null;
  /** `LADDER[pickRung - 1]`, or null alongside a null `pickRung`. */
  pickSleeve: string | null;
  /** The incumbent AFTER clamping into the candidate set — see the D4 note on `computeY1`. */
  incumbentRung: number;
  /** `RS(best) − RS(incumbent)` in cross-sectional sd, or null when either side has no RS. */
  margin: number | null;
  /** Consecutive closes (this one included) on which the margin cleared `Y1_MARGIN`. Recomputed from
   *  the series every read — this is the field that must never become a column. */
  streak: number;
  /** true ⇔ the pick differs from the incumbent, i.e. margin AND persistence both cleared. */
  switched: boolean;
  /** The D4 candidate set actually used, plus the printable label embedded in `reason`. Returned
   *  rather than left implicit so the /lab wire can SHOW the ceiling and decide silence off the same
   *  numbers this function ranked over — a caller re-deriving the clamp would be free to drift from
   *  it. */
  bounds: { lo: number; hi: number; label: string };
  /** Legible one-liner for the /lab overlay strip. */
  reason: string;
}

/**
 * Resolve the RS pick under the band's D4 candidate cap and the two-sided switch gate.
 *
 * `rsHistory` is the RS map at each of the PRIOR closes, oldest→newest and excluding the current
 * close (the caller builds it by truncating the same series and re-running `computeLegRs`); only its
 * tail matters. `incumbentRung` is the M5-gated held rung, falling back to `band.lo` when null.
 *
 * **Deviation from the plan spec, deliberate:** the spec says a non-switch returns `incumbentRung`
 * verbatim, which would emit a rung MORE AGGRESSIVE than `band.lo` whenever the held leg sits above
 * the band — contradicting the same spec's "danger's cap on aggression is inviolable to the RS pick".
 * That conflict is resolved toward the inviolable: the incumbent is CLAMPED into the candidate set
 * before anything else, and the clamped value is what is reported and held.
 */
export function computeY1(
  rs: Map<Sleeve, number | null>,
  band: Y1Band,
  incumbentRung: number | null,
  rsHistory: Map<Sleeve, number | null>[],
): Y1Result {
  const lo = Math.min(Math.max(1, Math.round(band.lo)), R1_FLOOR_RUNG);
  const hi = Math.max(lo, Math.min(R1_FLOOR_RUNG, Math.round(band.hi) + Y1_REACH));
  const incumbent = Math.min(Math.max(lo, Math.round(incumbentRung ?? band.lo)), hi);
  const incumbentSleeve = LADDER[incumbent - 1] as Sleeve;
  const bounds = `candidates ${lo}-${hi}`;
  const boundsOut = { lo, hi, label: bounds };

  let bestRung: number | null = null;
  let bestRs: number | null = null;
  for (let rung = lo; rung <= hi; rung++) {
    const sleeve = LADDER[rung - 1];
    if (!sleeve) continue;
    const value = rs.get(sleeve);
    if (value == null || !Number.isFinite(value)) continue;
    // Ascending scan, so an RS tie within epsilon lets the LATER (more defensive) rung win.
    if (bestRs == null || value > bestRs + RS_TIE_EPSILON || Math.abs(value - bestRs) <= RS_TIE_EPSILON) {
      bestRs = value;
      bestRung = rung;
    }
  }

  const incumbentRs = rs.get(incumbentSleeve) ?? null;

  if (bestRung == null || bestRs == null || incumbentRs == null) {
    return {
      pickRung: incumbent,
      pickSleeve: incumbentSleeve,
      incumbentRung: incumbent,
      margin: null,
      streak: 0,
      switched: false,
      bounds: boundsOut,
      reason: `RS unavailable - holding ${incumbentSleeve} (${bounds})`,
    };
  }

  const bestSleeve = LADDER[bestRung - 1] as Sleeve;
  const margin = bestRs - incumbentRs;

  if (bestRung === incumbent) {
    return {
      pickRung: incumbent,
      pickSleeve: incumbentSleeve,
      incumbentRung: incumbent,
      margin: 0,
      streak: 0,
      switched: false,
      bounds: boundsOut,
      reason: `${incumbentSleeve} leads its candidates - holding (${bounds})`,
    };
  }

  // Two-sided gate: identical margin AND persistence are required in either direction, so the pick
  // cannot chatter between two legs trading places on cross-sectional noise.
  const clears = (m: Map<Sleeve, number | null>): boolean => {
    const b = m.get(bestSleeve);
    const i = m.get(incumbentSleeve);
    if (b == null || i == null || !Number.isFinite(b) || !Number.isFinite(i)) return false;
    return b - i >= Y1_MARGIN;
  };

  let streak = 0;
  if (margin >= Y1_MARGIN) {
    streak = 1;
    for (let i = rsHistory.length - 1; i >= 0 && streak < Y1_PERSIST; i--) {
      if (!clears(rsHistory[i] as Map<Sleeve, number | null>)) break;
      streak++;
    }
  }

  const switched = streak >= Y1_PERSIST;
  const marginStr = margin.toFixed(2);
  const reason = switched
    ? `${bestSleeve} leads ${incumbentSleeve} by ${marginStr} sd for ${streak}/${Y1_PERSIST} closes - switching (${bounds})`
    : margin >= Y1_MARGIN
      ? `${bestSleeve} leads by ${marginStr} sd but only ${streak}/${Y1_PERSIST} closes - holding ${incumbentSleeve} (${bounds})`
      : `${bestSleeve} leads by ${marginStr} sd, under the ${Y1_MARGIN} sd bar - holding ${incumbentSleeve} (${bounds})`;

  return {
    pickRung: switched ? bestRung : incumbent,
    pickSleeve: switched ? bestSleeve : incumbentSleeve,
    incumbentRung: incumbent,
    margin,
    streak,
    switched,
    bounds: boundsOut,
    reason,
  };
}
