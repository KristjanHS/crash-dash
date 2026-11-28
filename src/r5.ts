/**
 * R5 vol-target sizing — a cut-only gross-exposure scalar on the held leg.
 *
 * R5 answers "how much of the held rung do we actually own", where R1/R4 answer "which rung".
 * It reads ONE series — the held leg's `LEGP_*` closes — and turns its realized volatility into a
 * gross multiplier in [`R5_MIN_GROSS`, 1.0].
 *
 * ⚠ DISPLAY-ONLY. `gross` must not reach `computeField`, `dial.band`, or anything `run-*.ts`
 * reads; R5 adds no column and no notify dependency. Three falsifiers, each run to zero hits:
 *   1. this stage adds no file under `supabase/migrations/` (the schema gained no R5 dependency) —
 *      `git show --name-only --format= <stage SHAs> -- supabase/migrations/` → zero lines. (The old
 *      form, `grep -rn computeR5 supabase/migrations/`, was VACUOUS: a `.sql` file cannot contain a
 *      TS symbol, so it could never fail.)
 *   2. the notify path holds no R5 reference — `grep -rn "computeR5" src/run-*.ts src/dial-assembly.ts
 *      src/t1dial.ts src/alert-band.ts` → zero hits (a `run-*.ts`-only grep is
 *      not transitive). The genuinely STRONG form is the import property: *the only non-test importer
 *      of `src/r5.js` anywhere in `src/ api/ public/ scripts/` is `src/lab-overlays.ts`* —
 *      `grep -rn 'r5\.js' src api public scripts | grep -v '\.test\.' | grep -v '^src/lab-overlays\.ts:' | grep -vE '^[^:]+:[0-9]+: *(\*|//)'`
 *      → zero lines.
 *   3. the front-end renders R5 generically, with no overlay-specific branch —
 *      `grep -rn '"r5"\|overlays\.r5' public/` → zero hits (the old `public/lab.js`-only form missed
 *      `d.overlays?.["r5"]`, destructuring, and every other `public/*.js` file).
 *
 * Pure leaf: same closes → same result. No I/O, no DB, no persisted state — the volatility is
 * recomputed from the series on every read.
 *
 * **Vintage note (the Stage-3 `LEGP_*` seam).** `LEGP_*` levels are vintage-mixed: rows written by
 * the deep backfill carry `adjClose` back-adjusted to the fetch date, while every cron row is that
 * day's price-only close, and insert-missing freezes the seam permanently. The real mechanism that
 * makes this safe is the closes provider's back-adjustment convention, not the smallness of the distortion: the feed
 * adjusts `adjClose` to the *latest date of the fetch*, so a ONE-SHOT seed lands the seam where the
 * adjustment factor is ≈1.0 and no return is distorted at all. The risk trigger is a **RE-RUN
 * backfill**: insert-missing leaves the old rows on their stale basis, creating a real seam. Measured
 * at the ~4%/yr worst-leg dividend drift, one 4% return injected into a series realizing exactly 15%
 * moves realized vol 15.0% → 20.6% and gross 1.00 → 0.75 — a two-step visible trim persisting ~20
 * trading days. So R5 is immune for the one-shot seed and NOT immune to a re-run. Y1's
 * cross-sectional ranking is not immune either way; that is Stage 5's problem, not this one.
 *
 * Constants are METHODOLOGICAL (a convention, a structural bound, or a symmetry) — none is fitted to
 * a replayed world ("no backtest as arbiter"). All six are
 * pinned by `r5.test.ts`.
 */

import type { SeriesPoint } from "./store.js";

/** Lookback windows, in OBSERVATIONS (closes), evaluated as an ensemble and reduced by `max` — never
 *  a single lookback, per the repo's E1/S4 discipline, and biased toward the more cautious (higher)
 *  read. The method card's own stated "~20–60d" span. Pinned by `r5.test.ts` "a series calm for 60d
 *  but violent in the last 20 uses the 20d (higher) vol". @internal */
export const R5_WINDOWS = [20, 60] as const;

/** Target annualized volatility. 15%/yr ≈ the long-run realized vol of a broad global equity book,
 *  so gross sits at 1.0 in calm regimes and the overlay is SILENT by default — the posture the
 *  idle-cash constraint (D6) demands. Not fitted to any world. Pinned by `r5.test.ts` "a series
 *  realizing exactly R5_TARGET_VOL yields gross 1.00". */
export const R5_TARGET_VOL = 0.15;

/** Floor on gross ⇒ R5's own cash can never exceed `1 − R5_MIN_GROSS` (40%). Anything deeper is the
 *  R4 breaker's territory, which is what keeps the two overlays from double-counting the same cash.
 *  Pinned by `r5.test.ts` "a 60%-vol series clamps to R5_MIN_GROSS, not lower". */
export const R5_MIN_GROSS = 0.6;

/** Structural cap: a PIK cannot lever, so R5 is CUT-ONLY and never boosts above fully-invested. */
const R5_MAX_GROSS = 1.0;

/** Quantization step for `gross`. Coarsening the output means a 1%-vol wiggle cannot produce a daily
 *  sizing decision — the card's named failure mode ("every day a sizing decision → more override
 *  opportunities"). Pinned by `r5.test.ts` "gross is always a multiple of R5_GROSS_STEP". @internal */
export const R5_GROSS_STEP = 0.05;

/** Minimum observations before R5 may emit a number, = `max(R5_WINDOWS)`: the longest window must be
 *  FULL, because a partial window would understate vol and so overstate gross. Pinned by
 *  `r5.test.ts` "59 observations ⇒ degraded, 60 ⇒ a number". */
export const R5_MIN_OBS = Math.max(...R5_WINDOWS);

/** Span bound: the newest `R5_MIN_OBS` closes must span no more calendar days than this, or R5
 *  degrades instead of sizing. Without it a 60-row series straddling a dark stretch computes a
 *  multi-week move as a one-day return, inflates vol, and paints a live trim with no degrade marker
 *  — and Stage 3.1 writes `LEGP_*` rows in `degrade()`'s starve-first tail, so multi-day gaps are an
 *  EXPECTED failure mode, not a freak one. 60 trading days normally spans ~84 calendar days, so 120
 *  is ~1.4× the expected span: generous enough that a holiday-heavy stretch or the three different
 *  venue calendars the nine legs trade on never trips it, tight enough that a genuinely dark
 *  multi-week stretch does. ONE-SIDED-VERIFIABLE (too small warms up spuriously, too large is
 *  silent), which is why it is set generous rather than tight. Methodological, not fitted
 *  ("no backtest as arbiter"). Pinned by `r5.test.ts` "a 60-close series spanning more than
 *  R5_MAX_SPAN_DAYS degrades; at the bound it sizes". @internal */
export const R5_MAX_SPAN_DAYS = 120;

const MS_PER_DAY = 86_400_000;

/** Calendar days between two ISO `YYYY-MM-DD` dates, or null if either is unparseable. Parsed as UTC
 *  so a DST boundary cannot shift the difference off an integer. */
function spanDays(first: string, last: string): number | null {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / MS_PER_DAY;
}

/** Trading days per year — the conventional annualization factor for a daily-return stdev. */
const TRADING_DAYS = 252;

interface R5Result {
  /** Gross exposure multiplier on the held leg ∈ [`R5_MIN_GROSS`, 1.0], quantized to
   *  `R5_GROSS_STEP`. `null` ⇔ `degraded` — never a fabricated trim. */
  gross: number | null;
  /** The annualized realized vol the sizing was read off (the ensemble max), or null when degraded. */
  realizedVol: number | null;
  /** true ⇒ too few / unusable observations ⇒ `gross` is null and the caller displays
   *  "fully invested / warming up". */
  degraded: boolean;
  /** Legible one-liner for the /lab overlay strip. */
  reason: string;
}

/**
 * Annualized sample stdev of the daily log returns implied by `closes`.
 *
 * Returns null when the input cannot support a stdev — fewer than two returns, or any non-finite /
 * non-positive close (a log return is undefined there, and silently dropping such a point would
 * splice two non-adjacent dates into one bogus return).
 */
function annualizedVol(closes: number[]): number | null {
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
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

/** Quantize onto the `R5_GROSS_STEP` grid. Applied AFTER the clamp, and both bounds are exact
 *  multiples of the step, so quantizing can never push `gross` back outside the range. The
 *  `toFixed` round-trip strips the float dust `0.05 * n` accumulates (0.7500000000000001). */
function quantize(gross: number): number {
  const steps = Math.round(gross / R5_GROSS_STEP);
  return Number((steps * R5_GROSS_STEP).toFixed(10));
}

/**
 * Size the held leg from its own close history.
 *
 * `heldLegCloses` is the leg's `LEGP_*` series oldest→newest, exactly as `store.getSeries` returns
 * it. Only the newest `max(R5_WINDOWS)` points are consulted; extra history is ignored, not averaged
 * in, so a longer read costs nothing but slack against missing dates.
 *
 * Those points must also be date-CONTIGUOUS within `R5_MAX_SPAN_DAYS`, or the result degrades: 60
 * rows straddling a dark stretch would otherwise read a multi-week move as one daily return.
 *
 * A window of N is N CLOSES ⇒ N−1 log returns — which is why `R5_MIN_OBS` observations exactly fill
 * the longest window rather than falling one short.
 */
export function computeR5(heldLegCloses: SeriesPoint[]): R5Result {
  const closes = heldLegCloses.map((p) => p.value);

  if (closes.length < R5_MIN_OBS) {
    return {
      gross: null,
      realizedVol: null,
      degraded: true,
      reason: `warming up - ${closes.length}/${R5_MIN_OBS} closes, holding fully invested`,
    };
  }

  // Contiguity gate: the window must be a genuine ~3-month stretch, not 60 rows dredged from either
  // side of a dark gap. See `R5_MAX_SPAN_DAYS`.
  const obsWindow = heldLegCloses.slice(-R5_MIN_OBS);
  const span = spanDays(
    (obsWindow[0] as SeriesPoint).date,
    (obsWindow[obsWindow.length - 1] as SeriesPoint).date,
  );
  if (span == null) {
    return {
      gross: null,
      realizedVol: null,
      degraded: true,
      reason: "unreadable close dates - holding fully invested",
    };
  }
  if (span > R5_MAX_SPAN_DAYS) {
    return {
      gross: null,
      realizedVol: null,
      degraded: true,
      reason: `stale series - the last ${R5_MIN_OBS} closes span ${span} days (max ${R5_MAX_SPAN_DAYS}), holding fully invested`,
    };
  }

  // Ensemble over every window, reduced by max: the most cautious read wins.
  const vols: number[] = [];
  for (const window of R5_WINDOWS) {
    const vol = annualizedVol(closes.slice(-window));
    if (vol == null) {
      return {
        gross: null,
        realizedVol: null,
        degraded: true,
        reason: `unusable closes in the ${window}d window - holding fully invested`,
      };
    }
    vols.push(vol);
  }

  const realizedVol = Math.max(...vols);

  // A dead-flat series realizes zero vol; the ratio is +Infinity, which the cap absorbs. Guarding
  // here keeps the arithmetic finite rather than relying on Infinity surviving the clamp.
  const raw = realizedVol > 0 ? R5_TARGET_VOL / realizedVol : R5_MAX_GROSS;
  const gross = quantize(Math.min(R5_MAX_GROSS, Math.max(R5_MIN_GROSS, raw)));

  const volPct = (realizedVol * 100).toFixed(1);
  const grossPct = (gross * 100).toFixed(0);
  const reason =
    gross >= R5_MAX_GROSS
      ? `realized vol ${volPct}% ≤ target ${(R5_TARGET_VOL * 100).toFixed(0)}% - fully invested`
      : gross <= R5_MIN_GROSS
        ? `realized vol ${volPct}% - gross floored at ${grossPct}% (deeper cuts are R4's)`
        : `realized vol ${volPct}% vs target ${(R5_TARGET_VOL * 100).toFixed(0)}% - gross ${grossPct}%`;

  return { gross, realizedVol, degraded: false, reason };
}
