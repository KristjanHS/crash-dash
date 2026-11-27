/**
 * Forward-excess EVENT-STUDY harness with a label-rotation placebo arm — OFFLINE, READ-ONLY.
 *
 * (Stage 1.1 = the engine; Stage 1.2 wires the two
 * probe specs `ebpCalmTerciles()` / `dispThreeLevel()`, both scoring through the real notify seam.)
 *
 * WHY THIS EXISTS. W2 ran this study as a throwaway `.mts` and deleted it, leaving its method
 * recorded only in a comment block in `src/danger-ladder.ts`. Three rulings now depend on
 * re-running it, so it is built once, committed and pinned instead of re-derived from prose.
 *
 * THE PLACEBO IS THE POINT. A conditional-return claim owes a placebo arm
 * (`.claude/rules/research-probes.md`): rotate the labels cyclically so the bucket COUNTS and
 * CLUSTERING are preserved exactly and only the dates are wrong, then re-measure. On W2's study
 * the placebo reproduced or exceeded the real effect for 3 of 5 members — regime clustering alone
 * manufactures signal-shaped numbers, and only the placebo told the two apart. This harness runs
 * SIX placebo arms (±1/±2/±3 years in the label series' own cadence) BY DEFAULT rather than W2's
 * single rotation, because one arm cannot distinguish "the real effect beat the placebo" from "that
 * one rotation happened to land badly". A spec may pre-register a larger arm set via
 * `placeboRotations` — required whenever the study's pass bar names a permutation p, since p is
 * floored at `1/(arms+1)` (see `rotationOffsets`).
 *
 * NOT A CUT-FITTING TOOL. Nothing this harness computes is a shippable threshold. Bucket
 * boundaries a caller derives from a full subsample (e.g. tercile edges) are IN-SAMPLE even when
 * the underlying z is point-in-time; they license an AXIS, never a live cut. A shipped cut is
 * derived separately, point-in-time, on the repo's expanding-percentile convention.
 *
 * OFFLINE + READ-ONLY, structurally: the only I/O is `readFixture` over committed
 * `scripts/backtest/data/*.csv`. No feed call, no network, no DB, no store, and it NEVER writes
 * into `scripts/backtest/data/` or `calibration.json` — a write there would read as an unreviewed
 * vintage bump. `--json=<path>` writes only to a path the caller names, and `assertSafeJsonPath`
 * ENFORCES that — the sentence above is executable, not just asserted.
 *
 * Usage:
 *   npm run probe:event-study -- --probe=none              # print the constant table and exit
 *   npm run probe:event-study -- --probe=ebp|disp|cr|vl|rt|xa|f5|all [--json=out.json]
 */
import { writeFileSync } from "node:fs";
import {
  CONFIRM_CLOSES,
  type Indicator,
  VELOCITY_WINDOW,
} from "../../src/domain-types.js";
import { confirmedStateSeries, rawStateSeries } from "../../src/domain-fold.js";
import { resolveCuts } from "../../src/domain-cuts.js";
import { LADDER } from "../../src/families.js";
import { ALL_INDICATORS } from "../../src/registry.js";
import { DISP, FXH, R7 } from "../../src/registry-composite.js";
import { EBP } from "../../src/registry-fred.js";
import { F5 } from "../../src/registry-price.js";
import { breadthReadingSeries } from "../../src/scorers-price.js";
import {
  bullSteepenerReadingSeries,
  dispersionReadingSeries,
  fxHavenReadingSeries,
} from "../../src/scorers-composite.js";
import { smoothedLevelReadingSeries } from "../../src/scorers-core.js";
import { SMOOTHED_LEVEL_OF } from "../../src/family-descriptor-rows.js";
import { quantile } from "../../src/slow.js";
import { synthesizedCalib } from "../../src/synth-cuts.js";
import { assertSafeJsonPath, loadPublishedVintage, readFixture, type Unavailable } from "./drift-guard.js";
import { expandingZ } from "./expanding-z.js";
import { argOf } from "../lib/cli.js";
import { mean } from "../lib/stats.js";

export type Leg = (typeof LADDER)[number];

// ---------- constants (exported: the Stage 1.3 test pins these) ----------

/**
 * Forward horizons in **trading days of the LEG series**, for every probe.
 *
 * 20 is chosen a priori and equals `VELOCITY_WINDOW` (`src/domain-types.ts`). 60 is a ROBUSTNESS CHECK
 * ONLY: a ruling moves a number only if it holds at BOTH. Never sweep horizons and pick the best.
 * Monthly label series keep this same axis — the label date maps to the first leg observation on
 * or after it, then 20/60 LEG observations forward — so the two probes share one horizon axis and
 * no monthly-return convention has to be invented.
 */
export const HORIZONS_TD = [20, 60] as const;

/**
 * A bucket with fewer contiguous runs than this is reported THIN and moves nothing, in either
 * direction. W2 ruled 17 / 20 / 21 episodes thin and 134 / 272 usable, so the boundary lives in
 * that gap — `MIN_EPISODES ∈ (21, 134)` is the pinned bound, not the literal 30.
 */
export const MIN_EPISODES = 30;

/** Observations per year, by label cadence — the placebo rotation's unit. */
export const OBS_PER_YEAR = { daily: 250, monthly: 12 } as const;

/** Rotation offsets in years; applied in BOTH directions ⇒ 6 placebo arms per spec.
 *  This is the DEFAULT arm set. A spec may instead pre-register `placeboRotations: N` (see
 *  `rotationOffsets`) — the 6-arm default is unchanged for every existing caller. */
export const PLACEBO_OFFSET_YEARS = [1, 2, 3] as const;

/**
 * The placebo arm offsets for one spec, in label-series index units.
 *
 * Default: `PLACEBO_OFFSET_YEARS` in both directions (6 arms) — unchanged, so every pre-existing
 * probe spec keeps byte-identical arms.
 *
 * `placeboRotations: N` instead spreads N rotations evenly around the cycle,
 * `k_j = round(j·n/(N+1))` for `j = 1…N`. WHY THIS MATTERS AND IS NOT A PREFERENCE: the permutation
 * p a study can report is bounded below by `1/(arms+1)`, so a 6-arm set floors p at ≈0.143 and a
 * pre-registered `p ≤ 0.05` would be unsatisfiable BY CONSTRUCTION — a gate that can never pass.
 * 199 arms makes p reachable to 0.005.
 *
 * Throws when the requested arms cannot be realized as DISTINCT non-zero shifts (a short label
 * series): a silently-deduped arm set would inflate p's denominator against arms that never existed.
 */
export function rotationOffsets(n: number, placeboRotations: number | undefined, cadence: "daily" | "monthly"): number[] {
  if (placeboRotations === undefined) {
    return PLACEBO_OFFSET_YEARS.flatMap((y) => {
      const k = OBS_PER_YEAR[cadence] * y;
      return [k, -k];
    });
  }
  if (!Number.isInteger(placeboRotations) || placeboRotations < 1) {
    throw new Error(`[event-study] placeboRotations must be a positive integer (got ${placeboRotations})`);
  }
  const out = new Set<number>();
  for (let j = 1; j <= placeboRotations; j++) out.add(Math.round((j * n) / (placeboRotations + 1)) % n);
  out.delete(0);
  if (out.size !== placeboRotations) {
    throw new Error(
      `[event-study] placeboRotations=${placeboRotations} over a ${n}-observation label series yields only ` +
        `${out.size} distinct non-zero shifts — the permutation p would be computed against arms that do not ` +
        `exist. Lower the arm count or lengthen the series.`,
    );
  }
  return [...out];
}

/**
 * A calm-arm month is excluded if any of the next N months is non-calm. A 60-trading-day forward
 * window opening in month *t* would otherwise overlap the crisis and smuggle the crossing's
 * information into the "calm" arm — manufacturing a positive result out of the very thing the
 * probe exists to exclude. 3 months ≈ 60 trading days, the longest horizon.
 */
export const CRISIS_SHADOW_MONTHS = 3;

/** Evidence class of a leg's fixture — how literally its row may be read. */
export type Evidence = "EXACT" | "WEAK" | "UNMEASURABLE";

/**
 * Ladder sleeve → committed price fixture, or an `Unavailable` reason. Mirrors `DRIFT_FIXTURES`'
 * shape and is keyed by the `LADDER` sleeve names so a completeness test can pin it against
 * `LADDER` exactly (Stage 1.3).
 *
 * A leg with no committed CSV is EMITTED as an `UNMEASURABLE` row rather than omitted: silent
 * omission is how "excluded" and "forgotten" become indistinguishable.
 */
export const LEG_FIXTURE: Readonly<Record<Leg, string | Unavailable>> = {
  Semis: "scripts/backtest/data/smh_adj.csv",
  "S&P IT": "scripts/backtest/data/qqq.csv",
  EM: "scripts/backtest/data/eem.csv",
  // Measurable since 2026-08-05: the leg's OWN
  // instrument, exported from the prod `LEGP_VALUE` chain (`scripts/backtest/export-leg-fixtures.ts`, the
  // `data-g4/` producer) into the `data/` shape this harness reads. The old "no committed CSV" line was only
  // ever a `data/` vs `data-g4/` path gap, never a missing series. 3017 rows, 2014-09-11 → 2026-08-03
  // (~11.9y); the only >5-calendar-day gaps are three Xetra Christmas weeks (2014/2018/2025).
  Value: "scripts/backtest/data/value.csv",
  "S&P 500": "scripts/backtest/data/spy.csv",
  "ex-US": "scripts/backtest/data/vea.csv",
  // Repointed off the pre-rename `vym.csv` proxy to the leg's OWN instrument (Stage 5.1 of
  // the leg swap; design §11.6 CR-4). Deliberately its
  // own commit, so the vintage move it causes is attributable to changing WHICH SERIES the leg is
  // measured on, separately from any `xa` cell the measurement then adds.
  "EU-Fin": "scripts/backtest/data/exsh.csv",
  Health: "scripts/backtest/data/xlv.csv",
  Staples: "scripts/backtest/data/xlp.csv",
};

/**
 * Evidence class per leg. EXACT = the fixture IS the leg's index. WEAK = a proxy, US-scoped or
 * differently-constructed; a WEAK leg cannot move a cell on its own — it needs an EXACT co-signer
 * with the same direction PASSing in the same run.
 */
export const LEG_EVIDENCE: Readonly<Record<Leg, Evidence>> = {
  Semis: "EXACT",
  "S&P IT": "WEAK", // qqq.csv is a 100-name growth index, not the IT sector
  EM: "EXACT",
  // WEAK, and the grade is DERIVED from provenance, not picked (the Value
  // weight retune's ruling). The finding:
  // the series is ONE instrument end-to-end — same fund, same ISIN (IE00BL25JM42), same Xetra
  // line. Nothing in this repo splices it: `legCloseReadingRows` (`src/scoreboard.ts`) chains EUR ratios
  // within a SINGLE `LEG_TICKER` ticker's own close series, `LEG_TICKER.Value` has never been repointed
  // (`git log -S'XDEV' -- src/scoreboard.ts` → only the file's creating commit), and the closes provider's own
  // `firstTradeDate` for `XDEV.DE` is 2014-09-11 with `chartPreviousClose` 25.534 — exactly this fixture's
  // first row. So the plan's premise that XDEV post-dates 2020 and must be chained onto a proxy is FALSE.
  // What blocks EXACT is the INDEX, not the instrument: the fund tracked the DB Equity Value Factor Index
  // from its 2014-09-11 launch and only switched to MSCI World Enhanced Value on 2016-11-03, taking
  // its current name with it. ~2.1y of the window is therefore a differently-constructed value index, which
  // is a different-instrument segment in the sense the grade cares about ⇒ WEAK.
  //   SOURCED, not asserted (verified 2026-08-05). The DWS/Xtrackers factsheet for this ISIN carries the
  //   change as a footnote on the index name: "On 03.11.2016 the ETF changed its underlying benchmark to
  //   track the MSCI World Enhanced Value (USD) Index (TRN) and subsequently changed its name to MSCI World
  //   Value UCITS ETF. Prior to the change the ETF tracked the DB Equity Value Factor Index." —
  //   https://etf.dws.com/en-lu/AssetDownload/Index/50091c87-b664-45c5-87a4-8f653f65c9bc/Factsheet.pdf
  //   (product page https://etf.dws.com/en-gb/IE00BL25JM42-msci-world-value-ucits-etf-1c/ is a JS-only SPA
  //   and serves no fetchable copy of the footnote). The share-class KID corroborates from the other side:
  //   past performance "up to 2015 (inclusive) is that of the DB Equity Value Factor Index. 2016 shows a
  //   combined performance of both indices."
  //   ⚠ THE OFFICIAL POST-SWITCH INDEX NAME IS `MSCI World Enhanced Value (USD) Index (TRN)`; TRN is
  //   total-return NET, so the "(Net)" this file used elsewhere is semantically right but is not the
  //   published string. ⚠ DO NOT CITE justETF FOR THE DATE: its profile
  //   (https://www.justetf.com/en/etf-profile.html?isin=IE00BL25JM42) lists the CURRENT index and the
  //   2014-09-11 launch with NO index-change note at all, so read alone it implies the fund tracked
  //   Enhanced Value since inception — the opposite of the finding. It corroborates only the launch date.
  //   "From its launch" is an INFERENCE, not a quote: no source says "from launch", but the KID's
  //   "up to 2015 inclusive" leaves no gap against a 2014-09-11 start.
  // ⚠ Consequence: a WEAK leg cannot move a cell alone (`verdictOf` → `PASS (weak — …)`) and `Value` has no
  // EXACT co-signer, so its rows are a REPORT, not a gate. A future study wanting EXACT should either
  // window the study to 2016-11-03 forward or re-source off `IWVL.L` (same index, 2014-10 inception).
  Value: "WEAK",
  "S&P 500": "EXACT",
  "ex-US": "EXACT",
  // EXACT since Stage 5.1: `exsh.csv` IS this leg's instrument (EXSH.DE, EUR/Xetra, 2008-01-02 forward),
  // not a proxy for it — so the row may be read literally and needs no co-signer. Was WEAK while the
  // fixture was `vym.csv`, a US high-dividend fund standing in for a European leg.
  "EU-Fin": "EXACT",
  // EXACT since 2026-08-02 — THE MEASUREMENT WAS TAKEN, not asserted. The precondition these two cells
  // carried (re-run
  // `npm run probe:event-study` with the grades re-declared, on BOTH `--probe=xa` and `--probe=vl`, before
  // quoting the upgrade as fact) is DISCHARGED — research §10 ran both studies under exactly this
  // re-declaration. The grounds: the 2026-08-02 ticker swap (`src/scoreboard.ts`) re-pointed both legs to
  // `QDVG.DE` / `ZPDS.DE`, and `xlv.csv` / `xlp.csv` ARE those underlyings — the S&P 500 Health Care and
  // Consumer Staples Select Sector indices — so the fixture IS the leg's index, which is what EXACT means.
  // The old grade's reason ("US-scoped fixtures against global XDWH.DE/XDWS.DE") described instruments the
  // legs no longer track. Seated 2026-08-02.
  // ⚠ THE RIDER SURVIVES THE UPGRADE: the fixtures are USD-space, while the legs' unhedged EUR-marked FX
  // channel sits entirely outside them. EXACT grades the INDEX match, never the currency of the mark.
  Health: "EXACT",
  Staples: "EXACT",
};

// ---------- spec / row types ----------

export interface LabelPoint {
  date: string;
  bucket: string;
}

export interface EventStudySpec {
  /** Human label for the study, printed as the table's title. */
  label: string;
  cadence: "daily" | "monthly";
  /** Ascending by date. Buckets are arbitrary strings; the baseline one (if any) is not scored. */
  labels: readonly LabelPoint[];
  /** Bucket treated as the "off" state and not scored, or `undefined` when buckets partition. */
  baselineBucket?: string;
  legs?: readonly Leg[];
  horizons?: readonly number[];
  /** Per-leg fixture override, merged over `LEG_FIXTURE`. Exists so a study may score the legs'
   *  OWN persisted instruments (G4's exported `LEGP_*` CSVs) instead of the committed proxies —
   *  `LEG_FIXTURE` itself is never mutated, so every other spec keeps its arms. */
  legFixture?: Partial<Record<Leg, string | Unavailable>>;
  /** Per-leg evidence override, merged over `LEG_EVIDENCE`. Must move WITH `legFixture`: an
   *  override that repoints a leg at its own instrument but leaves the leg classed WEAK would
   *  under-read a real result, and one that upgrades a proxy to EXACT would over-read it. */
  legEvidence?: Partial<Record<Leg, Evidence>>;
  /** Pre-registered placebo arm count; see `rotationOffsets`. Omit for the 6-arm default. */
  placeboRotations?: number;
}

export type Verdict = "UNMEASURABLE" | "THIN" | "PLACEBO-FAIL" | "PASS" | "PASS (weak — needs an exact co-signer)";

export interface EventStudyRow {
  bucket: string;
  leg: Leg;
  horizon: number;
  /** Contiguous runs of `bucket` in the label series' own index — rising-edge entries. */
  nEpisodes: number;
  /** Label days in this bucket that had a resolvable forward return at this horizon. */
  nDays: number;
  excessPp: number;
  placeboMaxPp: number;
  /** `|excessPp| / placeboMaxPp` — MAGNITUDE-ONLY and SIGN-BLIND, so a FAVOURABLE excess scores just
   *  as high as a damaging one (2026-07-26: `bullSteepenerReach` `Staples AMBER @60d` = 1.68 on a
   *  −3.06pp excess). It ranks a cell against ITS OWN placebo band and nothing else: two arms' ratios
   *  are NOT comparable when their episode counts and window-day totals differ, which is the norm. */
  placeboRatio: number;
  /**
   * Permutation p — the rank of the real arm among (arms + 1) by |excess|:
   * `(1 + #{k : |placebo_k| ≥ |real|}) / (1 + arms)`. Bounded below by `1/(arms+1)`, so on the
   * 6-arm default it can never go under ≈0.143; only a spec that pre-registers `placeboRotations`
   * can report a p a `≤ 0.05` gate could clear (see `rotationOffsets`).
   */
  placeboP: number;
  /** Every placebo arm's excess in pp, arm order = `rotationOffsets`. Exposed so a caller may build
   *  a JOINT statistic (e.g. a cross-leg spread) on the SAME rotation index across legs and get its
   *  permutation p from the same arms, rather than re-implementing the rotation. */
  placeboExcessPp: number[];
  /** Per (bucket, leg) — identical on both of a pair's horizon rows by construction. */
  verdict: Verdict;
  evidence: Evidence;
}

// ---------- primitives ----------

/**
 * Contiguous runs of `bucket` in the label series' own index (NOT calendar) — i.e. rising-edge
 * entries into the bucket. Same semantics as `risingEdgeFires` (`replay.ts`), generalized from
 * `State` to an arbitrary bucket string.
 */
export function bucketEpisodes(buckets: readonly string[], bucket: string): number {
  let n = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] === bucket && buckets[i - 1] !== bucket) n++;
  }
  return n;
}

/**
 * Cyclic label rotation: `rotate(b, k)[i] = b[(i − k + n) % n]`. Cyclic so the bucket COUNTS and
 * CLUSTERING survive exactly and only the DATES are wrong — that is what makes the placebo a
 * control for regime clustering rather than a different experiment.
 */
export function rotate<T>(values: readonly T[], k: number): T[] {
  const n = values.length;
  if (n === 0) return [];
  const shift = ((k % n) + n) % n;
  const out = new Array<T>(n);
  for (let i = 0; i < n; i++) out[i] = values[(i - shift + n) % n]!;
  return out;
}

export interface ForwardSeries {
  dates: string[];
  /** `fwd[h][i] = p[i+h]/p[i] − 1`, `NaN` where `i + h` runs past the fixture end. */
  fwd: Map<number, number[]>;
}

/**
 * Load a leg fixture and precompute its forward returns at each horizon.
 * `fwd(leg, i, h) = p[i + h] / p[i] − 1`, dropped (NaN) when `i + h` runs past the fixture end.
 */
export function readForward(relPath: string, horizons: readonly number[]): ForwardSeries {
  const obs = readFixture(relPath);
  const dates = obs.map((o) => o.date);
  const px = obs.map((o) => o.value);
  const fwd = new Map<number, number[]>();
  for (const h of horizons) {
    const arr = new Array<number>(px.length).fill(NaN);
    for (let i = 0; i + h < px.length; i++) {
      const p0 = px[i]!;
      if (p0 > 0) arr[i] = px[i + h]! / p0 - 1;
    }
    fwd.set(h, arr);
  }
  return { dates, fwd };
}

/**
 * Index of the first leg observation on or after `date`, or `-1` if the fixture ends first.
 * Binary search over the ascending date strings (ISO dates compare lexicographically).
 */
export function alignIndex(dates: readonly string[], date: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! < date) lo = mid + 1;
    else hi = mid;
  }
  return lo < dates.length ? lo : -1;
}

/**
 * Permutation p for one statistic against its placebo arms: `(1 + #{k : |arm_k| ≥ |real|}) / (1 + K)`.
 *
 * MAGNITUDE-ONLY / SIGN-BLIND, matching `placeboRatio` — a favourable excess is ranked exactly as a
 * damaging one. The `+1` in both terms is the standard permutation correction (the real arm is one of
 * the K+1 arrangements), which is also why p can never go below `1/(K+1)`. Non-finite arms are
 * DROPPED from the denominator, never counted as passes: an arm whose bucket resolved no forward
 * return is an arm that was not run.
 * Returns `NaN` when the real statistic is non-finite, or when no arm ran.
 */
export function permutationP(real: number, arms: readonly number[]): number {
  if (!Number.isFinite(real)) return NaN;
  const live = arms.filter((a) => Number.isFinite(a));
  if (live.length === 0) return NaN;
  const ge = live.filter((a) => Math.abs(a) >= Math.abs(real)).length;
  return (1 + ge) / (1 + live.length);
}

// ---------- the study ----------

/**
 * Run one event study.
 *
 * **Study window** = the intersection of the label series' date span and that LEG's fixture span,
 * so the unconditional baseline is regime-matched per leg: a leg whose fixture starts in 2007 is
 * never compared against a 1993-anchored mean. A leg whose fixture starts after the label series
 * is not an error — its window is shorter and its `n` is reported. Never quote a short-window `n`
 * as if it were the full sample.
 *
 * **Excess** = `mean(fwd | bucket label days) − mean(fwd | ALL leg observations in the study
 * window)`, in percentage points. The baseline is the unconditional leg mean over the same window,
 * not the mean over the other buckets — a bucket is scored against "doing nothing", which is what
 * a rotation decision is actually compared to.
 */
export function runEventStudy(spec: EventStudySpec): EventStudyRow[] {
  const legs = spec.legs ?? LADDER;
  const horizons = spec.horizons ?? HORIZONS_TD;
  const labels = [...spec.labels].sort((a, b) => a.date.localeCompare(b.date));
  const buckets = labels.map((l) => l.bucket);
  const scored = [...new Set(buckets)].filter((b) => b !== spec.baselineBucket).sort();
  const offsets = rotationOffsets(buckets.length, spec.placeboRotations, spec.cadence);

  const rows: EventStudyRow[] = [];
  for (const leg of legs) {
    const fixture = spec.legFixture?.[leg] ?? LEG_FIXTURE[leg];
    const evidence = spec.legEvidence?.[leg] ?? LEG_EVIDENCE[leg];
    if (typeof fixture !== "string") {
      // Emitted, never omitted — the gap must be visible in the table (see LEG_FIXTURE docblock).
      for (const bucket of scored) {
        for (const horizon of horizons) {
          rows.push({
            bucket,
            leg,
            horizon,
            nEpisodes: 0,
            nDays: 0,
            excessPp: NaN,
            placeboMaxPp: NaN,
            placeboRatio: NaN,
            placeboP: NaN,
            placeboExcessPp: [],
            verdict: "UNMEASURABLE",
            evidence,
          });
        }
      }
      continue;
    }

    const series = readForward(fixture, horizons);
    if (series.dates.length === 0) throw new Error(`[event-study] ${leg}: empty fixture ${fixture}`);

    // Label index → leg observation index, once per leg. `-1` = OUTSIDE this leg's study window,
    // and both ends matter. Past the fixture END there is no observation at all. BEFORE the fixture
    // START, `alignIndex` would honestly answer "the first observation on or after" — index 0 — for
    // every such label, collapsing an entire pre-start era onto one date and weighting that single
    // observation by the size of the era. Dropping them is what "study window = label span ∩ fixture
    // span" means, and it is why a leg's `nDays` is reported per leg rather than assumed shared.
    const firstObs = series.dates[0]!;
    const legIdx = labels.map((l) => (l.date < firstObs ? -1 : alignIndex(series.dates, l.date)));
    // Study window: label span ∩ fixture span, expressed as leg-observation indices.
    const firstLabel = labels[0]!.date;
    const lastLabel = labels.at(-1)!.date;
    const winStart = alignIndex(series.dates, firstLabel);
    const winEndExcl = alignIndex(series.dates, lastLabel);
    const winEnd = winEndExcl === -1 ? series.dates.length : winEndExcl + 1;

    for (const bucket of scored) {
      const nEpisodes = bucketEpisodes(buckets, bucket);
      const per = new Map<
        number,
        { excessPp: number; placeboMaxPp: number; nDays: number; placeboExcessPp: number[] }
      >();

      for (const horizon of horizons) {
        const fwd = series.fwd.get(horizon)!;
        // Unconditional baseline: every leg observation inside the study window.
        const base: number[] = [];
        for (let i = Math.max(winStart, 0); i < winEnd; i++) {
          const v = fwd[i];
          if (v !== undefined && Number.isFinite(v)) base.push(v);
        }
        const baseline = mean(base);

        const excessOf = (bs: readonly string[]): { excessPp: number; nDays: number } => {
          const hit: number[] = [];
          for (let j = 0; j < bs.length; j++) {
            if (bs[j] !== bucket) continue;
            const i = legIdx[j]!;
            if (i < 0) continue;
            const v = fwd[i];
            if (v !== undefined && Number.isFinite(v)) hit.push(v);
          }
          return { excessPp: (mean(hit) - baseline) * 100, nDays: hit.length };
        };

        const real = excessOf(buckets);
        let placeboMaxPp = 0;
        const placeboExcessPp: number[] = [];
        for (const k of offsets) {
          const p = excessOf(rotate(buckets, k));
          placeboExcessPp.push(p.excessPp);
          if (Number.isFinite(p.excessPp)) placeboMaxPp = Math.max(placeboMaxPp, Math.abs(p.excessPp));
        }
        per.set(horizon, { excessPp: real.excessPp, placeboMaxPp, nDays: real.nDays, placeboExcessPp });
      }

      const verdict = decideVerdict(nEpisodes, horizons, per, evidence);
      for (const horizon of horizons) {
        const m = per.get(horizon)!;
        rows.push({
          bucket,
          leg,
          horizon,
          nEpisodes,
          nDays: m.nDays,
          excessPp: m.excessPp,
          placeboMaxPp: m.placeboMaxPp,
          placeboRatio: m.placeboMaxPp === 0 ? Infinity : Math.abs(m.excessPp) / m.placeboMaxPp,
          placeboP: permutationP(m.excessPp, m.placeboExcessPp),
          placeboExcessPp: m.placeboExcessPp,
          verdict,
          evidence,
        });
      }
    }
  }
  return rows;
}

/**
 * The verdict rule, per (bucket, leg) — one verdict shared by the pair's horizon rows.
 *
 * THIN — `nEpisodes < MIN_EPISODES`; moves nothing in either direction.
 * PLACEBO-FAIL — `|real| ≤ max_k |placebo_k|` at EITHER horizon, or the real excess changes sign
 *   between horizons. This is the branch that killed W2's F9 / CG / F11.
 * PASS — non-thin, same sign at both horizons, and `|real| > max_k |placebo_k|` at both. A WEAK
 *   leg's PASS is annotated: it still needs an EXACT co-signer in the same direction to move a cell.
 */
function decideVerdict(
  nEpisodes: number,
  horizons: readonly number[],
  per: ReadonlyMap<number, { excessPp: number; placeboMaxPp: number; nDays: number }>,
  evidence: Evidence,
): Verdict {
  if (evidence === "UNMEASURABLE") return "UNMEASURABLE";
  if (nEpisodes < MIN_EPISODES) return "THIN";
  const ms = horizons.map((h) => per.get(h)!);
  if (ms.some((m) => m.nDays === 0 || !Number.isFinite(m.excessPp))) return "THIN";
  const signs = new Set(ms.map((m) => Math.sign(m.excessPp)));
  if (signs.size !== 1 || signs.has(0)) return "PLACEBO-FAIL";
  if (ms.some((m) => Math.abs(m.excessPp) <= m.placeboMaxPp)) return "PLACEBO-FAIL";
  return evidence === "WEAK" ? "PASS (weak — needs an exact co-signer)" : "PASS";
}

// ---------- probe specs (Stage 1.2) ----------

/**
 * Probe A — EBP calm-regime terciles, MONTHLY.
 *
 * A month is CALM iff its state through the REAL notify seam is CONFIRMED `GREEN`: the exact chain
 * `assessDrift` uses (`loadPublishedVintage` → `synthesizedCalib` → `resolveCuts("EBP", …)` →
 * `rawStateSeries`) plus the 2-close confirmation fold. The binding amber is therefore the
 * published `credit/ebp_*` vintage's worst-of (≈0.862 in plotted units, via the z-leg), NOT the
 * registry `1.0` — scoring the latter was drift-guard's finding I1 and is not reintroduced here.
 *
 * A calm month is EXCLUDED when any of the next `CRISIS_SHADOW_MONTHS` months is non-`GREEN`, so a
 * 60-trading-day forward window opening in that month cannot overlap a crisis and smuggle the
 * crossing's information into the "calm" arm.
 *
 * Buckets `T1 / T2 / T3` split the RETAINED calm subsample at its OWN 33rd/67th percentiles of the
 * point-in-time EBP own-z (`expandingZ`, look-ahead-clean). The percentile EDGES are in-sample;
 * admissible here because nothing becomes a live cut — the probe licenses an AXIS, and the positive
 * branch derives its shipped cut on an expanding percentile separately (Stage 2.2P). No baseline
 * bucket: the terciles partition the sample, so the unconditional study-window mean is the baseline.
 */
export function ebpCalmTerciles(): EventStudySpec {
  const obs = readFixture("scripts/backtest/data/ebp.csv");
  const histories = new Map([[EBP.id, obs.map((o) => o.value)]]);
  const calib = synthesizedCalib(EBP, loadPublishedVintage(), histories);
  const cuts = resolveCuts(EBP.id, calib, EBP.direction ?? "HIGH");
  const raw = rawStateSeries(EBP, obs, cuts);
  const confirmed = confirmedStateSeries(raw, CONFIRM_CLOSES);
  // `rawStateSeries` aligns to `obs[VELOCITY_WINDOW..]`; the point-in-time z runs over the FULL
  // series and is sliced to the same origin, so date, confirmed state and z share one index.
  const alignedDates = obs.slice(VELOCITY_WINDOW).map((o) => o.date);
  const z = expandingZ(obs.map((o) => o.value)).slice(VELOCITY_WINDOW);

  const calm: { date: string; z: number }[] = [];
  for (let i = 0; i < confirmed.length; i++) {
    if (confirmed[i] !== "GREEN") continue;
    let shadowed = false;
    for (let j = i + 1; j <= i + CRISIS_SHADOW_MONTHS && j < confirmed.length; j++) {
      if (confirmed[j] !== "GREEN") {
        shadowed = true;
        break;
      }
    }
    if (shadowed) continue;
    const zi = z[i];
    if (zi === undefined || !Number.isFinite(zi)) continue; // z is NaN until two priors exist
    calm.push({ date: alignedDates[i]!, z: zi });
  }

  const sortedZ = calm.map((c) => c.z).sort((a, b) => a - b);
  const p33 = quantile(sortedZ, 1 / 3);
  const p67 = quantile(sortedZ, 2 / 3);
  const labels: LabelPoint[] = calm.map((c) => ({
    date: c.date,
    bucket: c.z < p33 ? "T1" : c.z < p67 ? "T2" : "T3", // T1 = z<p33, T2 = [p33,p67), T3 = z≥p67
  }));
  return { label: "EBP calm-regime terciles (own-z, crisis-shadowed)", cadence: "monthly", labels };
}

/**
 * Probe B — three-level DISP (SPY·FEZ·EEM mean pairwise correlation), DAILY.
 *
 * Scores through the REAL production `dispersionReadingSeries` at its default cuts, taking each
 * `Reading`'s CONFIRMED `.state` (`buildReadings` applies the 2-close fold). Buckets `AMBER` / `RED`
 * are scored; `GREEN` is the baseline. Never reimplement `dispersionState`, the confirmation fold,
 * or `resolveCuts` here — a probe that re-derives what it tests can only test itself.
 */
export function dispThreeLevel(): EventStudySpec {
  const spy = readFixture("scripts/backtest/data/spy.csv");
  const fez = readFixture("scripts/backtest/data/fez.csv");
  const eem = readFixture("scripts/backtest/data/eem.csv");
  const readings = dispersionReadingSeries(DISP, spy, fez, eem);
  const labels: LabelPoint[] = readings.map((r) => ({ date: r.date, bucket: r.state }));
  return { label: "DISP three-level (SPY·FEZ·EEM meanCorr)", cadence: "daily", labels, baselineBucket: "GREEN" };
}

// ---------- W2 stress-episode probe specs (Stage 2.1) --

/**
 * `confirmedStateSeries` labels for a generic FRED indicator scored through the REAL notify seam —
 * the exact chain `assessDrift` uses (`loadPublishedVintage` → `synthesizedCalib` → `resolveCuts` →
 * `rawStateSeries`) plus the 2-close confirmation fold. Never reimplement the state logic here — a
 * probe that re-derives what it tests only tests itself. `rawStateSeries` aligns its output to
 * `obs[VELOCITY_WINDOW..]` (see `scoreDaySeries`), so the confirmed series and that date slice share
 * one index. No proxy leg is wired (mirrors `ebpCalmTerciles` exactly): F1's Baa10y velocity proxy
 * is a production wired-caller override, not part of the own-series scoring chain the probes reuse.
 */
export function confirmedStateLabels(indicator: Indicator, relPath: string): LabelPoint[] {
  const obs = readFixture(relPath);
  const smoothed = SMOOTHED_LEVEL_OF[indicator.id];
  if (smoothed) {
    // SMOOTHED-LEVEL ids (R1, R8) score their level pair against a trailing MEAN, not the latest
    // close (`scoreSmoothedLevel`, confirmers.ts) — R1 is the two-window rule (`window` mean AMBER,
    // `redWindow` mean RED), so bucket its confirmed reading states, never the raw-close path below.
    const readings = smoothedLevelReadingSeries(indicator, obs, smoothed.window, undefined, smoothed.redWindow);
    return readings.map((r) => ({ date: r.date, bucket: r.state }));
  }
  const histories = new Map([[indicator.id, obs.map((o) => o.value)]]);
  const calib = synthesizedCalib(indicator, loadPublishedVintage(), histories);
  const cuts = resolveCuts(indicator.id, calib, indicator.direction ?? "HIGH");
  const raw = rawStateSeries(indicator, obs, cuts);
  const confirmed = confirmedStateSeries(raw, CONFIRM_CLOSES);
  const alignedDates = obs.slice(VELOCITY_WINDOW).map((o) => o.date);
  return confirmed.map((state, i) => ({ date: alignedDates[i]!, bucket: state }));
}

/**
 * Probe C — credit stress, DAILY. Buckets are F1 (US HY-OAS, `hyoas.csv`) confirmed AMBER/RED
 * states; GREEN is the baseline. HY-OAS is the broadest, exactly-tickered credit-stress series and
 * the `cr` family cell is a `max` fold, so F1-lit is the dominant credit-stress episode set. The
 * harness then measures forward excess for all 9 legs — W2's 7 target cells (defensive AS CLASSED THEN;
 * `EU-Fin` was reclassified cyclical 2026-08-01) + the reference
 * leg — in one run. (W2 spec §3: F1 primary; EBP is the exact co-signer — `creditStressEbp` below,
 * also under `--probe=cr`. NOT `--probe=ebp`, which is the calm-tercile study, a different framing.)
 */
export function creditStress(): EventStudySpec {
  const F1 = ALL_INDICATORS.find((i) => i.id === "F1");
  if (!F1) throw new Error("[event-study] creditStress: F1 not in ALL_INDICATORS");
  const labels = confirmedStateLabels(F1, "scripts/backtest/data/hyoas.csv");
  return { label: "Credit stress — F1 HY-OAS confirmed AMBER/RED", cadence: "daily", labels, baselineBucket: "GREEN" };
}

/**
 * Probe C2 — credit stress, EBP co-signer arm, MONTHLY (W2 spec Stage 2.1b).
 *
 * Same stress framing as `creditStress`, over the family's other exactly-tickered credit series. It
 * exists because the F1 arm leaves `cr × {Health, Staples}` THIN (24 AMBER / 16 RED entries, below
 * `MIN_EPISODES`): `hyoas.csv` only starts 2008-03 and its RED is one persistent GFC cluster. `ebp.csv`
 * runs 1973-01 → 2026-06, and the binding constraint is the defensive leg fixtures (`xlv`/`xlp` start
 * 1998-12), so this arm's usable window is ≈27y against the F1 arm's ≈18y — it adds the 2000–02 credit
 * stress the F1 arm cannot see at all.
 *
 * ⚠ Two caveats that travel WITH any verdict this arm produces, and do not license discounting a null:
 *   1. It can still come back THIN. `bucketEpisodes` counts bucket ENTRIES (run rising edges), not
 *      observations, and monthly labels flicker far less than daily ones — a longer span does NOT
 *      guarantee ≥ `MIN_EPISODES`.
 *   2. Monthly labels scored over 20/60-TRADING-DAY horizons are finer than the input strictly supports
 *      (the same coarseness `ebpCalmTerciles` carries; decision record F9-2).
 *
 * Scores through the identical real-notify chain `ebpCalmTerciles` uses (`confirmedStateLabels`), so the
 * two EBP probes differ only in framing — stress AMBER/RED here vs calm GREEN terciles there.
 */
export function creditStressEbp(): EventStudySpec {
  const labels = confirmedStateLabels(EBP, "scripts/backtest/data/ebp.csv");
  return {
    label: "Credit stress — EBP confirmed AMBER/RED (co-signer, MONTHLY)",
    cadence: "monthly",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe D — equity-vol stress, DAILY. Buckets are R5 (VIX, `vix.csv`) confirmed AMBER/RED states;
 * GREEN is the baseline. VIX is the canonical equity-vol stress series. VT (VIX-term) co-signer is
 * optional in this stage; the primary VIX arm is enough to smoke-pin.
 */
export function volStress(): EventStudySpec {
  const R5 = ALL_INDICATORS.find((i) => i.id === "R5");
  if (!R5) throw new Error("[event-study] volStress: R5 not in ALL_INDICATORS");
  const labels = confirmedStateLabels(R5, "scripts/backtest/data/vix.csv");
  return { label: "Vol stress — R5 VIX confirmed AMBER/RED", cadence: "daily", labels, baselineBucket: "GREEN" };
}

/**
 * Probe D2 — BOND-vol stress, DAILY. Buckets are R6 (MOVE, `move.csv`) confirmed AMBER/RED states;
 * GREEN is the baseline. Written to adjudicate
 * `MEMBER_WEIGHT.R6`'s five zeros (`EM` / `S&P 500` / `ex-US` /
 * `Value` / `Health`) — the row was reassigned volatility→rates at the Stage-1.2 taxonomy merge
 * with "weights unchanged", i.e. the family moved and the row did not.
 *
 * It is the SAME framing as `volStress` on a different member, deliberately: R5/VIX's Health and
 * Staples cells are measured zeros from that arm (`src/danger-ladder.ts`, W2 spec Stage 2.2), so
 * running MOVE through the identical harness makes the two rows comparable row-for-row rather than
 * arguing R6's column from VIX's.
 *
 * ⚠ This arm scores the registry pair through `classify` alone. R6 left `CALIB_MAP` 2026-08-30, so
 * `resolveCuts` returns `{}` and no measured leg ORs in; production's rolling-percentile + velocity
 * legs live in `scoreMoveLevel` and are NOT reachable from this spec.
 */
export function moveVolStress(): EventStudySpec {
  const R6 = ALL_INDICATORS.find((i) => i.id === "R6");
  if (!R6) throw new Error("[event-study] moveVolStress: R6 not in ALL_INDICATORS");
  const labels = confirmedStateLabels(R6, "scripts/backtest/data/move.csv");
  return { label: "Bond-vol stress — R6 MOVE confirmed AMBER/RED", cadence: "daily", labels, baselineBucket: "GREEN" };
}

/**
 * MOVE-native regime cuts used by `moveVolStressStrict` — the DESCRIPTIVE prior already recorded in
 * R6's registry docblock (~80 calm / ~120 stress / ~150+ crisis), taken a priori and never swept.
 * NOT a shippable threshold and not a proposal to move R6's [USER]-ruled pair: this harness
 * licenses an AXIS, never a live cut (see the file docblock, "NOT A CUT-FITTING TOOL").
 */
export const MOVE_STRESS_LEVEL = 120;
export const MOVE_CRISIS_LEVEL = 150;

/**
 * Probe D3 — bond-vol stress at MOVE-NATIVE regime cuts, DAILY. The POWER arm for the bond-vol row.
 *
 * WHY A SECOND ARM. `moveVolStress` scores the shipped [USER]-ruled pair, which is lit on ~two
 * fifths of days by design (~38% at the retired 90/105 pair; the 2026-07-23 and 2026-07-29 rulings
 * ACCEPTED that over-fire as the price of an earlier bond-vol trigger). A bucket covering two fifths of the sample cannot show a forward excess
 * against the sample's own unconditional mean whatever the member's true reach is, so a null there
 * is a statement about the CUT, not about the leg column. This arm re-buckets the same series at
 * the rarer native regime lines so the reach question can actually be answered.
 *
 * It deliberately scores the registry-convention level leg ALONE — a clone of R6 carrying the
 * strict pair, so the bucket is a pure MOVE-level study; it is NOT production's state
 * (`scoreMoveLevel`'s rolling + velocity legs are absent here).
 */
export function moveVolStressStrict(): EventStudySpec {
  const R6 = ALL_INDICATORS.find((i) => i.id === "R6");
  if (!R6) throw new Error("[event-study] moveVolStressStrict: R6 not in ALL_INDICATORS");
  const strict: Indicator = {
    ...R6,
    thresholds: { amberLevel: MOVE_STRESS_LEVEL, redLevel: MOVE_CRISIS_LEVEL },
  };
  const obs = readFixture("scripts/backtest/data/move.csv");
  const confirmed = confirmedStateSeries(rawStateSeries(strict, obs), CONFIRM_CLOSES);
  const alignedDates = obs.slice(VELOCITY_WINDOW).map((o) => o.date);
  const labels: LabelPoint[] = confirmed.map((state, i) => ({ date: alignedDates[i]!, bucket: state }));
  return {
    label: `Bond-vol stress — MOVE native regime cuts ${MOVE_STRESS_LEVEL}/${MOVE_CRISIS_LEVEL} (research axis, NOT a shipped cut)`,
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe D4 — CURVE INVERSION, DAILY. Buckets are R1 (T10Y3M, `t10y3m.csv`) confirmed AMBER/RED;
 * GREEN is the baseline. Written to adjudicate
 * `MEMBER_WEIGHT.R1` and `MEMBER_WEIGHT.R7` — today BYTE-IDENTICAL
 * rows, i.e. an assertion that inversion and bull-steepener reach all nine legs the same way.
 *
 * It runs as a PAIR with `bullSteepenerReach` below, under one probe key, for the same reason the
 * `cr` arms do: the rung's question is comparative, and two arms scored through one harness on one
 * fixture set are the only way to read the two rows against each other rather than each against a
 * remembered number. `npm run probe:r1-r7` already settled that the two members are not the same
 * EVENT (2.0% AMBER+ co-firing, conditional inside its placebo band); this pair asks the separate
 * question the weight table actually encodes — whether the two events damage the legs alike.
 *
 * ⚠ R1 scores through the smoothed two-window carrier (`SMOOTHED_LEVEL_OF.R1`), not raw closes:
 * AMBER = the 21-obs mean past `redLevel` (or the armed rung over that mean), RED = the 63-obs mean
 * past it. No `CALIB_MAP.R1`, no EVT/own-z leg, no drawdown leg (all un-wired 2026-08-31). It is
 * still a common bucket (19.1% of fixture days AMBER-or-worse, 10.4% RED — re-measured over
 * `t10y3m.csv`) — read `nEpisodes` and the placebo columns before any excess, since a bucket this
 * common cannot show much excess against the sample's own unconditional mean whatever the leg
 * column's truth is. The LOW-base-rate arm is R7 itself, so the pair still spans the rarity range.
 */
export function curveInversion(): EventStudySpec {
  const R1 = ALL_INDICATORS.find((i) => i.id === "R1");
  if (!R1) throw new Error("[event-study] curveInversion: R1 not in ALL_INDICATORS");
  const labels = confirmedStateLabels(R1, "scripts/backtest/data/t10y3m.csv");
  return {
    label: "Curve inversion — R1 10y−3m confirmed AMBER/RED",
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe D5 — BULL STEEPENER (2y-led), DAILY. The second half of rung 3's pair. Buckets are R7's
 * confirmed states straight off `bullSteepenerReadingSeries` — the production scorer, whose
 * `.state` is already folded through `CONFIRM_CLOSES` by `buildReadings(confirm = true)`, so it
 * needs no `confirmedStateLabels` wrapper (the same shape `crossAssetStress` uses for FXH). The
 * composite state rule is never reimplemented here.
 *
 * ⚠ R7 is `confirmer: true` in the registry — under the retired verdict engine it could only raise
 * severity once the RATE base was elevated. The danger engine `MEMBER_WEIGHT` feeds has NO such
 * gate, so this arm is scored UNGATED, which is what the weight row is about. Do not read a result
 * here as licensing anything about the confirmer flag.
 */
export function bullSteepenerReach(): EventStudySpec {
  const spread = readFixture("scripts/backtest/data/t10y3m.csv");
  const dgs2 = readFixture("scripts/backtest/data/dgs2.csv");
  const dgs10 = readFixture("scripts/backtest/data/dgs10.csv");
  const labels: LabelPoint[] = bullSteepenerReadingSeries(R7, spread, dgs2, dgs10).map((r) => ({
    date: r.date,
    bucket: r.state,
  }));
  return {
    label: "Bull steepener — R7 2y-led confirmed AMBER/RED (ungated; the confirmer flag does not bind MEMBER_WEIGHT)",
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe D6 — 10y NOMINAL rate shock, DAILY. Buckets are R2 (DGS10 Δ20 velocity, `dgs10.csv`)
 * confirmed AMBER/RED; GREEN is the baseline. Written to adjudicate
 * `MEMBER_WEIGHT.R2` and
 * `MEMBER_WEIGHT.R4`. ⚠ DO NOT RE-TYPE AN ENUMERATION HERE: a hand-typed copy of these rows has been
 * wrong TWICE; read `MEMBER_WEIGHT.R2`/`.R4` in `src/danger-ladder.ts` for the live cells. What this
 * pair tests is an IDENTITY CLAIM — whether the nominal and the real row encode the same reach across
 * the nine legs — and that design does not depend on the literals. ⚠ The one leg they have diverged on,
 * `Semis`, has moved TWICE: the rows were cell-for-cell EQUAL between 2026-08-03 and 2026-08-04, and on
 * 2026-08-04 they re-diverged the OTHER WAY ROUND from the
 * original (R4 now above R2). The pair-of-arms design is unaffected — only the sign of the gap changed.
 *
 * It runs as a PAIR with `realRateShock` below under one probe key, for the same reason rung 3's
 * `curveInversion` / `bullSteepenerReach` pair does — the question is comparative, so both arms must
 * be scored through one harness on one fixture set and read side by side, never each against a
 * remembered number. `archive/probe-r2-r4.ts` already settled the EVENT question (Δ20 r 0.7731, below
 * the 0.90 same-factor line and below its own identity-only baseline 0.8786 — a baseline, NOT a floor,
 * since the residual term is signed and the measurement lands under it; the two are NESTED,
 * R2 a near-subset of R4). This arm asks the separate question the weight table encodes — whether
 * the nominal and real shocks damage the nine legs alike.
 *
 * ⚠ NESTING MAKES THE TWO ARMS NON-INDEPENDENT, and no harness output flags that. 274 of R2's 316
 * AMBER+ days are also R4 AMBER+ days (measured, `archive/probe-r2-r4.ts`), so these two label series share
 * most of their episodes: agreement between the arms is largely the shared days re-scored, NOT two
 * independent confirmations. Read a DISAGREEMENT as informative and an agreement as expected.
 *
 * ⚠ R2's scored cuts are NOT the registry 0.40/0.70 velocity pair alone — `confirmedStateLabels`
 * runs the production chain (`synthesizedCalib` → `resolveCuts`), so any calibrated leg in R2's
 * `CALIB_MAP` entry is ORed in exactly as prod does. R2 is the RARE arm here and R4 the common one —
 * the opposite rarity split from rung 3's pair.
 *
 * ⚠ QUOTE THE BASE RATE ON THE WINDOW THE ARM ACTUALLY RUNS (review fix, 2026-07-26 — it previously
 * said "5.4%", which is R2's rate on the 2003+ SHARED window `archive/probe-r2-r4.ts` reports, not on this
 * arm's). THIS arm walks the whole of `dgs10.csv`, 16,094 confirmed days 1962-01-30 → 2026-07-09,
 * where R2 is AMBER+ on **1,250 = 7.8%** (RED 348 = 2.2%). The 15.5% quoted for R4 elsewhere IS its
 * own window's number, because `dfii10.csv` (5,863 days from 2003-01-31) is the binding leg of the
 * shared window too — 907/5,863. Measured by driving `confirmedStateLabels` over each fixture
 * directly; the two rates are NOT comparable, they are 64 years vs 23.
 */
export function nominalRateShock(): EventStudySpec {
  const R2 = ALL_INDICATORS.find((i) => i.id === "R2");
  if (!R2) throw new Error("[event-study] nominalRateShock: R2 not in ALL_INDICATORS");
  const labels = confirmedStateLabels(R2, "scripts/backtest/data/dgs10.csv");
  return {
    label: "Nominal-rate shock — R2 DGS10 10y Δ20 confirmed AMBER/RED",
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe D7 — 10y REAL rate shock, DAILY. The second half of rung 4's pair: R4 (DFII10 Δ20 velocity,
 * `dfii10.csv`) confirmed AMBER/RED, GREEN baseline, through the identical `confirmedStateLabels`
 * chain as `nominalRateShock` so the two rows differ only in the member, never in the scoring path.
 *
 * ⚠ `dfii10.csv` starts 2003-01 (TIPS), while `dgs10.csv` runs from 1962 — so this arm's sample is
 * strictly shorter than its partner's and the two arms' `nEpisodes` / `nDays` are NOT comparable as
 * counts. Compare the per-leg VERDICTS, not the sample sizes.
 */
export function realRateShock(): EventStudySpec {
  const R4 = ALL_INDICATORS.find((i) => i.id === "R4");
  if (!R4) throw new Error("[event-study] realRateShock: R4 not in ALL_INDICATORS");
  const labels = confirmedStateLabels(R4, "scripts/backtest/data/dfii10.csv");
  return {
    label: "Real-rate shock — R4 DFII10 10y TIPS Δ20 confirmed AMBER/RED (sample starts 2003-01)",
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe E — cross-asset FX-haven stress, DAILY. Scores the production `fxHavenReadingSeries` (worst-of
 * the three H.10 FX legs' 20d haven-bid move) at its default cuts, taking each `Reading`'s CONFIRMED
 * `.state`; buckets AMBER / RED are scored, GREEN is the baseline. All three FX inputs are committed
 * (`dexuseu.csv` / `dexszus.csv` / `dexjpus.csv`), so this second `xa` arm is measurable-by-fixture.
 * The DISP arm of the `xa` family is `dispThreeLevel()`, reused directly under the `xa` probe key (it
 * is byte-identical to the stress framing — no clone). Never reimplement `fxHavenState` here.
 */
export function crossAssetStress(): EventStudySpec {
  const usEur = readFixture("scripts/backtest/data/dexuseu.csv");
  const chfUsd = readFixture("scripts/backtest/data/dexszus.csv");
  const jpyUsd = readFixture("scripts/backtest/data/dexjpus.csv");
  const readings = fxHavenReadingSeries(FXH, usEur, chfUsd, jpyUsd);
  const labels: LabelPoint[] = readings.map((r) => ({ date: r.date, bucket: r.state }));
  return {
    label: "FX-haven stress — FXH DEXUSEU·DEXSZUS·DEXJPUS worst-of confirmed AMBER/RED",
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
  };
}

/**
 * Probe F — F5 BREADTH/CONCENTRATION reach, DAILY. The owed arm, run under a BINDING pre-registration
 * (S4-R1, 2026-08-20); the five clauses below are
 * that pre-registration, not preferences.
 *
 *  1. Through THIS harness (`runEventStudy`), never re-implemented — it carries the six-arm
 *     label-rotation placebo, the permutation p, `MIN_EPISODES` and the `PLACEBO-FAIL` sign-flip.
 *  2. `HORIZONS_TD = [20, 60]`, the harness default. A ruling holds at BOTH or not at all; the
 *     horizon axis is never swept.
 *  3. **F5 only.** `scripts/backtest/data/rsp.csv` does not exist, so SPCONC cannot run offline. Since
 *     the 2026-08-30 split it is no longer F5's byte-level twin (its own `SPCONC_BAND` holds the older
 *     rolling-126 p85/p98 triple), so NOTHING transfers by construction — this arm measures F5 alone.
 *  4. XLK is wired for the `S&P IT` leg via the paired per-spec overrides below. `LEG_FIXTURE` ships
 *     `qqq.csv` there, graded WEAK ("a 100-name growth index, not the IT sector") — and here that
 *     fixture would ALSO be the label series' own numerator, scoring F5 against a leg built from
 *     half of itself. `xlk.csv` IS the S&P IT sector index, so the pair moves together: fixture and
 *     evidence, never one without the other.
 *  5. The label builder calls `breadthReadingSeries` VERBATIM — the shipped scorer, its own
 *     `BREADTH_BAND` triple (F5's own since the split), no restated cut. It deliberately does NOT route through
 *     `confirmedStateLabels`: that path runs `synthesizedCalib` → `resolveCuts`, which F5 is fenced
 *     off from (`thresholds: {}`, a bespoke dynamic per-point band). The same shape `dispThreeLevel`
 *     and `crossAssetStress` use. No 2-close fold is applied because F5's site does not apply one —
 *     verified on prod 2026-08-30, `rawState === state` on 800/800 served points.
 *
 * Consumer: `indicator-loop.md` §Keep-or-cut — an indicator earns its place. A PLACEBO-FAIL or ~zero excess argues demotion of F5's
 * dial/trend role; a clean positive excess closes F5 as validated. No cut retune hangs on this — F5's
 * live triple is whatever `BREADTH_BAND` carries (rolling-63 p88/p98.5 since 2026-08-30).
 *
 * ⚠ RULE ON THE `S&P IT` ROW ONLY. The harness scores all nine legs in one pass (every spec does),
 * and the other eight are CONTEXT — they were not pre-registered and reading a verdict off whichever
 * of nine rows came back best is the multiplicity the placebo arms cannot protect against.
 *
 * ⚠ The window is the QQQE fixture's, 2012-03-21 forward — F5's band needs both legs aligned, and
 * `qqqe.csv` starts there while `qqq.csv` runs from 1999. So this arm cannot see 2000-02 or 2008 at
 * all; it is a ~14-year post-GFC sample and every count it reports is on that window.
 */
export function breadthConcentration(): EventStudySpec {
  const qqq = readFixture("scripts/backtest/data/qqq.csv");
  const qqqe = readFixture("scripts/backtest/data/qqqe.csv");
  const labels: LabelPoint[] = breadthReadingSeries(F5, qqq, qqqe).map((r) => ({ date: r.date, bucket: r.state }));
  return {
    label: "Breadth concentration — F5 QQQ/QQQE at-12mo-high AMBER/RED (S&P IT leg on XLK)",
    cadence: "daily",
    labels,
    baselineBucket: "GREEN",
    legFixture: { "S&P IT": "scripts/backtest/data/xlk.csv" },
    legEvidence: { "S&P IT": "EXACT" },
  };
}

// ---------- reporting ----------

const fmt = (n: number, w: number, dp = 2): string =>
  (Number.isFinite(n) ? n.toFixed(dp) : n === Infinity ? "∞" : "—").padStart(w);

export function formatRows(title: string, rows: readonly EventStudyRow[]): string {
  const out: string[] = [`\n=== ${title} ===`];
  out.push(
    `${"bucket".padEnd(8)}${"leg".padEnd(10)}${"h".padStart(4)}${"nEpis".padStart(7)}${"nDays".padStart(7)}` +
      `${"excessPp".padStart(10)}${"placeboPp".padStart(11)}${"ratio".padStart(8)}${"p".padStart(8)}  verdict`,
  );
  out.push("-".repeat(96));
  for (const r of rows) {
    out.push(
      `${r.bucket.padEnd(8)}${r.leg.padEnd(10)}${String(r.horizon).padStart(4)}${String(r.nEpisodes).padStart(7)}` +
        `${String(r.nDays).padStart(7)}${fmt(r.excessPp, 10)}${fmt(r.placeboMaxPp, 11)}${fmt(r.placeboRatio, 8)}${fmt(r.placeboP, 8, 3)}  ` +
        `${r.verdict}${r.evidence === "WEAK" ? " [weak]" : ""}`,
    );
  }
  return out.join("\n");
}

export function formatConstants(): string {
  const legLines = LADDER.map((leg) => {
    const f = LEG_FIXTURE[leg];
    return `  ${leg.padEnd(10)} ${LEG_EVIDENCE[leg].padEnd(13)} ${typeof f === "string" ? f : f.reason}`;
  });
  return [
    "\n=== event-study harness — constants ===",
    `HORIZONS_TD           ${HORIZONS_TD.join(", ")}  (leg trading days; 60 is a robustness check, never a sweep)`,
    `MIN_EPISODES          ${MIN_EPISODES}  (below it a bucket is THIN and moves nothing)`,
    `OBS_PER_YEAR          daily=${OBS_PER_YEAR.daily}, monthly=${OBS_PER_YEAR.monthly}`,
    `PLACEBO_OFFSET_YEARS  ${PLACEBO_OFFSET_YEARS.join(", ")}  (both directions ⇒ ${PLACEBO_OFFSET_YEARS.length * 2} placebo arms by default;` +
      ` p floors at ${(1 / (PLACEBO_OFFSET_YEARS.length * 2 + 1)).toFixed(3)} — a spec needing p ≤ 0.05 must set placeboRotations)`,
    `CRISIS_SHADOW_MONTHS  ${CRISIS_SHADOW_MONTHS}  (calm-arm exclusion; ≈60 trading days, the longest horizon)`,
    "\nLEG_FIXTURE / LEG_EVIDENCE:",
    ...legLines,
  ].join("\n");
}

// ---------- CLI ----------


/** `--probe=ebp|disp|cr|vl|rt|xa|f5|all` → the specs to run; throws on an unknown value. */
function specsFor(probe: string): EventStudySpec[] {
  switch (probe) {
    case "ebp":
      return [ebpCalmTerciles()];
    case "disp":
      return [dispThreeLevel()];
    case "cr":
      // F1/HY-OAS primary + the EBP co-signer arm (Stage 2.1b); the F1 arm alone is THIN on the
      // defensive legs, so both arms run under one probe key and Stage 2.2 resolves them pairwise.
      return [creditStress(), creditStressEbp()];
    case "vl":
      return [volStress()];
    case "rt":
      // R6/MOVE sits in the RATES family since Stage 1.2, so its arm keys off `rt`, not `vl` —
      // even though the framing is `volStress`'s.
      // BOTH arms run: the shipped-cut one is production-faithful but low-power (38% of days lit),
      // the native-regime one is the arm with the rarity to answer the reach question.
      // Rung 3 adds the R1/R7 PAIR to the same key: the rung's question is comparative, so the two
      // arms must be readable side by side in one run (see `curveInversion`).
      // Rung 4 adds the R2/R4 PAIR on the same principle (see `nominalRateShock`) — and those two
      // arms are NESTED (274 of R2's 316 AMBER+ days are R4 days), so they are not independent.
      return [
        moveVolStress(),
        moveVolStressStrict(),
        curveInversion(),
        bullSteepenerReach(),
        nominalRateShock(),
        realRateShock(),
      ];
    case "f5":
      // The owed F5 breadth arm. Its own key: it is not a
      // member of any existing family framing, and its S&P IT leg runs on an overridden fixture.
      return [breadthConcentration()];
    case "xa":
      // DISP arm reused directly (not cloned) + the FXH second arm; both are the `xa` family stress.
      return [dispThreeLevel(), crossAssetStress()];
    case "all":
      return [
        ebpCalmTerciles(),
        dispThreeLevel(),
        creditStress(),
        creditStressEbp(),
        volStress(),
        moveVolStress(),
        moveVolStressStrict(),
        curveInversion(),
        bullSteepenerReach(),
        nominalRateShock(),
        realRateShock(),
        crossAssetStress(),
        breadthConcentration(),
      ];
    default:
      throw new Error(`[event-study] unknown --probe=${probe} (use ebp|disp|cr|vl|rt|xa|f5|all|none)`);
  }
}

const isMain = process.argv[1]?.endsWith("event-study.ts") ?? false;
if (isMain) {
  const probe = argOf("probe") ?? "all";
  const jsonPath = argOf("json");
  console.log(formatConstants());
  const rows: EventStudyRow[] = [];
  if (probe === "none") {
    console.log("\n--probe=none: constants only, no study run.");
  } else {
    for (const spec of specsFor(probe)) {
      const specRows = runEventStudy(spec);
      console.log(formatRows(spec.label, specRows));
      rows.push(...specRows);
    }
  }
  if (jsonPath) {
    // Enforces this file's own docblock claim instead of only asserting it — `--json=` takes a
    // caller-named path (2026-07-20 review, finding 3; same guard in `probe-drawdown-gate.ts`).
    assertSafeJsonPath(jsonPath);
    writeFileSync(jsonPath, JSON.stringify({ rows }, null, 2));
  }
}
