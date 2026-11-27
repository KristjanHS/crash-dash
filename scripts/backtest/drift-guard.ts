/**
 * Threshold-drift guard (W1 slice 3, 2026-07-20) — the falsification check for the defect
 * class W1 slices 1 and 2 fixed.
 *
 * THE CLASS: an indicator's cut is a hand-typed absolute authored against a regime the
 * series has since left, so the indicator is structurally incapable of changing state. It
 * still renders, still persists, still counts as a channel member — and contributes exactly
 * nothing. Two shipped instances: **F9** (Broad USD, pinned RED since 2018 because
 * `withSynthesizedPriors` never displaced the 110 registry prior) and **F3** (NFCI Risk,
 * permanently GREEN because its 0.5 amber sits ~4x above the series' post-2010 maximum).
 * Neither failed a test, neither raised an error; both were found by a human reading a chart.
 * (⚠ F9 is NO LONGER WATCHED HERE — its level axis was retired 2026-08-07 and the guard's
 * population is level-cut ids only. See the note where its `DRIFT_FIXTURES` entry used to be.)
 *
 * THE GUARD: over a trailing `DRIFT_WINDOW_YEARS` of each indicator's own committed history,
 * score every day through the REAL notify path (`resolveCuts` ∘ `synthesizedCalib` →
 * `rawStateSeries`) and require the resulting state to take more than one distinct value.
 * A cut that never moved in three years is not a signal.
 *
 * WHY THE REAL PATH, NOT A RE-IMPLEMENTATION: the thing under test IS the cut resolution.
 * `assessDrift` therefore builds its cuts exactly the way `confirmers.scoreWithCuts` does —
 * the published vintage layered under `synthesizedCalib`, then `resolveCuts` — so reverting
 * either W1 fix at its own seam turns this guard red without the guard knowing anything about
 * those fixes. A guard that re-derives the cut can only test itself.
 *
 * ⚠ **THE PUBLISHED VINTAGE IS NOT EMPTY, and scoring it as empty was a real defect (fixed
 * 2026-07-20, review finding I1).** This guard originally passed `[]` on the belief that "none
 * of these ids has a published row". False: `scripts/backtest/calibration.json`'s `params`
 * carries legacy shared `(market: null, mode: null)` rows for `ebp_*`, `vix_*`, `t10y3m_*`,
 * `move_*`, `dgs*` and `baa10y_*`, and `publish-calibration.ts` pushes exactly those to the
 * store that `getCalibration()` serves the notify path. Under `[]` the guard scored R5 at the
 * registry 20/30 while the phone fires on evtAmber 33.1955; R1 at 0.5/0 against -0.6485; EBP at
 * 1/2 against 1.0227. No verdict changed, but the guard was watching cuts that do not fire —
 * i.e. it could not have noticed the ones that do drifting. `loadPublishedVintage` reads the
 * same file the publisher reads, and takes ONLY the legacy `(null, null)` rows, because
 * `resolveCuts` without a `cell` is target-blind by construction and reads only those.
 *
 * WHY COMMITTED CSVs, NOT THE STORE: this runs in plain `npm run check` — no network, and
 * emphatically no `DB_TESTS=1` (the dev DB's history is irreplaceable). The fixtures under
 * `scripts/backtest/data/` are the existing committed-history convention; the guard extends
 * that set rather than inventing a parallel artifact.
 *
 * ⚠ **UNOBSERVABLE IS NOT DRIFT — the distinction is load-bearing.** Keyless FRED serves the
 * ICE BofA OAS series (F1's `BAMLH0A0HYM2`, F2's `BAMLC0A0CM`, F10's `BAMLEMCBPIOAS`, CCC's
 * `BAMLH0A3HYC`) over a rolling ~3-year window, so a 3-year drift window over them is a
 * window over the whole feed with no room left to establish that a cut *failed* to move.
 * Their cuts are UNOBSERVABLE, not proven dead, and reporting them as drift would make this a
 * false-positive machine that the next person disables — which is worse than not having it.
 * They are reported, never failed. Same ruling that kept F10 off the percentile seam
 * (`domain-cuts.ts` `CALIB_MAP`).
 *
 * The window is anchored to each fixture's OWN last observation, not to wall-clock `now`, so
 * the guard is deterministic and cannot go red merely because a fixture aged.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_INDICATORS } from "../../src/registry.js";
import { type Indicator, type Observation, type State } from "../../src/domain-types.js";
import {
  hasSynthPriors,
  resolveCuts,
  type CalibParamRow,
  type CalibrationCuts,
} from "../../src/domain-cuts.js";
import { rawStateSeries } from "../../src/domain-fold.js";
import { VELOCITY_WINDOW, type Thresholds } from "../../src/domain-types.js";
import { SMOOTHED_LEVEL_OF } from "../../src/family-descriptor-rows.js";
import { synthesizedCalib } from "../../src/synth-cuts.js";
import { backfillDepthFor } from "../backfill.js";
import { isoDay } from "../../src/dates.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Every `scripts/probe-*.ts` banner claims it NEVER writes into `scripts/backtest/data/` or
 * `calibration.json` — a write there reads as an unreviewed vintage bump. That was PROSE only:
 * `--json=<path>` takes whatever the caller names and hands it straight to `writeFileSync`
 * (2026-07-20 review, finding 3). This makes the claim executable. It lives here because the
 * vintage files this protects are exactly the ones this module's drift guard reads.
 *
 * Call it before ANY caller-named write, in every probe that takes `--json=`.
 */
export function assertSafeJsonPath(p: string): void {
  const norm = resolve(p).replaceAll("\\", "/");
  if (norm.includes("/scripts/backtest/data/") || norm.endsWith("calibration.json")) {
    throw new Error(
      `refusing to write ${p} — a write into scripts/backtest/data/ or calibration.json reads ` +
        `as an unreviewed vintage bump. Name a path outside them.`,
    );
  }
}
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const F1_VINTAGE = "data/BAMLH0A0HYM2-vintage.csv";

/**
 * The published calibration vintage the notify path resolves against, read off the same
 * `calibration.json` that `publish-calibration.ts` writes to the store.
 *
 * ONLY the legacy shared `(market, mode) = (null, null)` rows, mirroring `resolveCuts`'
 * target-blind branch: called without a `cell` it reads nothing else, so including per-cell
 * rows here would let the guard score a cut no `cell`-less caller can reach.
 */
export function loadPublishedVintage(): CalibParamRow[] {
  const file = JSON.parse(readFileSync(join(SCRIPT_DIR, "calibration.json"), "utf8")) as {
    params: Array<{ channel: string; metric: string; value: number; market?: string | null; mode?: string | null }>;
  };
  return file.params
    .filter((p) => (p.market ?? null) === null && (p.mode ?? null) === null)
    .map((p) => ({ channel: p.channel, metric: p.metric, value: p.value, market: null, mode: null }));
}

/** The trailing window, fixed at 3 years per the W1 contract (2026-07-20 `/qimpag` ruling). */
export const DRIFT_WINDOW_YEARS = 3;

/**
 * A fixture must span meaningfully MORE than the window it is asked about, else "the state
 * never changed" and "we only ever saw one regime" are the same observation. One extra year
 * on top of the 3-year window (plus `VELOCITY_WINDOW` lead-in, consumed by `rawStateSeries`).
 */
export const MIN_OBSERVABLE_YEARS = DRIFT_WINDOW_YEARS + 1;

/** Why an id carries no committed deep history — always a FEED property, never a shortcut. */
export type Unavailable = { reason: string };

/**
 * Every indicator whose live state comes from `classify` over a scalar level/velocity cut —
 * i.e. every id this drift class can reach. `covered.ts`-style completeness is asserted in
 * the test (`coveredIdsMatchRegistry`), so adding such an indicator without a decision here
 * fails the suite rather than silently escaping the guard.
 *
 * Value = the committed `date,value` fixture (repo-relative), or an `Unavailable` reason.
 */
export const DRIFT_FIXTURES: Readonly<Record<string, string | Unavailable>> = {
  // --- observable: deep, non-truncated committed history --------------------------------
  // ⚠ **R1 LEFT THIS MAP 2026-08-31** (option A): it is a
  // `SMOOTHED_LEVEL_OF` carrier now, so `levelCutIds()` excludes it by the R8 mechanism below and
  // the bijection test forbids a key. Its fixture CSV (`scripts/backtest/data/t10y3m.csv`) is
  // DELIBERATELY KEPT — the mean-space replacement test in `src/dashboard.score-indicator.test.ts` reads it.
  R5: "scripts/backtest/data/vix.csv",
  EBP: "scripts/backtest/data/ebp.csv",
  R6: "scripts/backtest/data/move.csv",
  F3: "scripts/backtest/data/nfcirisk.csv",
  // ⚠ **F9 LEFT THIS MAP 2026-08-07** (ruled).
  // `levelCutIds()` below derives this guard's population by filtering `ALL_INDICATORS` on a registry
  // `amberLevel`/`redLevel`, and F9's level axis was retired — so F9 is no longer in the population and
  // the completeness test (which asserts set equality in BOTH directions) cannot go green while an F9
  // entry survives. Two alternatives were declined at the ruling: widening the filter to any scalar cut
  // (enrols R2/R3/R4 at the cost of three new fixtures) and a hand-listed F9 carve-out.
  // **Recorded consequence, so it is not re-litigated: F9 — one of the two shipped instances of this
  // very defect class — is no longer drift-monitored, and no velocity-only indicator is.** The property
  // the guard asserted for F9 (its state series is not pinned flat over its committed history) is now
  // asserted directly, on the velocity axis, in `src/registry.test.ts`. ⚠ Its fixture CSV
  // (`scripts/backtest/data/broad_usd.csv`) is DELIBERATELY KEPT — that replacement test reads it.
  //
  // ⚠ **F11 LEFT THIS MAP 2026-08-08** (ruled),
  // by the identical mechanism one day later: its level axis was retired, so `levelCutIds()` no longer
  // admits it and the completeness test cannot go green while an F11 entry survives. The ruling was to
  // apply F9's resolution verbatim rather than re-litigate the two declined alternatives above.
  // **Recorded consequence: with F9 and F11 both gone, the drift guard now watches NO velocity-only
  // indicator and neither of the two shipped instances of the defect class it was built for.** The
  // property it asserted for F11 (its state series is not pinned flat over its committed history) is
  // asserted directly, on the velocity axis, in `src/registry.test.ts`. ⚠ Its fixture CSV
  // (`scripts/backtest/data/cny.csv`) is DELIBERATELY KEPT — that replacement test reads it.
  // ⚠ **BAA10Y LEFT THIS MAP 2026-08-11** with the indicator's outright retirement (it left
  // ALL_INDICATORS, so `assessAll` would throw and the bijection test forbids a key). It had
  // joined 2026-07-23 when its hand-set level pair replaced the σ-cuts. Its fixture CSV
  // (`scripts/backtest/data/baa10y.csv`) is not distributed with this repository.
  // EU2 (SovCISS France) rode this map 2026-07-30 → 2026-09-05 off `data/sov_cin_fr.csv`; the
  // indicator was removed outright and the fixture deleted with it (nothing else read it).
  // F1's ICE BofA feed is rolling-3y like F2/F10/CCC, but a pre-clamp 1996→2025 vintage was
  // archived before FRED's April 2026 history clamp (`data/README.md`), so F1 alone among the four is
  // observable — off a fixture that ENDS 2025-04-10, hence a 2022-04→2025-04 window, when the file is present.
  F1: existsSync(join(REPO_ROOT, F1_VINTAGE))
    ? F1_VINTAGE
    : { reason: "HY-OAS vintage file absent — not distributed with this repository (data/README.md)" },
  // --- unobservable: keyless FRED clamps ICE BofA OAS to a rolling ~3-year window ---------
  // A 3-year drift window over a ~3-year feed cannot distinguish "the cut is dead" from
  // "we have not watched long enough". Reported, never failed. Do NOT paper over this by
  // shortening the window — that trades a false negative for a false positive.
  // --- unobservable: no committed fixture vintage YET (crisis rung 1, 2026-07-24) ---------
  // NOT a feed clamp: keyless FRED serves both breakeven series in FULL (2003→). The Stage-1
  // session could not reach FRED (network-blocked env), so no vintage CSV is committed and the
  // 3y sweep has nothing to score. UPGRADE PATH (owed): commit fredgraph vintage CSVs
  // (t10yie.csv / t5yifr.csv, the BAA10Y pattern) and expect a DRIFT_CALM_ALLOWLIST assessment —
  // both cuts deliberately sit at the 2022 crisis-peak zone, so a calm trailing 3y window is
  // likely PINNED GREEN by design (crisis discriminators, the EBP shape).
  T10YIE: { reason: "no committed fixture vintage yet — feed serves full history keyless; commit t10yie.csv + calm-allowlist assessment (cut = 2022 crisis peak zone)" },
  T5YIFR: { reason: "no committed fixture vintage yet — feed serves full history keyless; commit t5yifr.csv + calm-allowlist assessment (red = the de-anchoring line)" },
  // OVX (crisis rung 2, 2026-07-24): same posture — no committed vintage CSV. Since S6 (2026-09-20
  // oil-nowcast plan, FEED_OF.OVX="prices") OVX scores off the price feed's `^OVX`, not FRED OVXCLS;
  // the available keyless source serves ~5y depth. UPGRADE PATH (owed): commit an `^OVX` vintage CSV + assessment — the
  // level cuts sit in the oil-vol blowout zone, so a calm trailing 3y window may be PINNED GREEN by
  // design (crisis discriminator).
  // ECISS (eufin top5 C2): keyless ECB serves full history; cuts are provisional until [USER] reads the chart.
  ECISS: { reason: "no committed fixture vintage yet — ECB CISS serves full history keyless; commit a vintage CSV + assessment once [USER] rules the cuts" },
  // HICP (estr-hike-side-leg R5): display-only Δ6m card; FRED serves full monthly history keyless.
  HICP: { reason: "no committed fixture vintage yet — FRED CP0000EZ19M086NEST serves full history keyless; display-only card, cuts [USER]-ruled 2026-10-03" },
  BONOS: { reason: "no committed fixture vintage yet — a keyless ES10Y source serves 2000+; Spain's own hand-set pair (contagion S2)" },
  OVX: { reason: "no committed fixture vintage yet — scores off `^OVX` (keyless source, ~5y) since S6; commit an ^OVX vintage CSV + assessment (cuts = oil-vol blowout zone)" },
  // BRENT (crisis rung 3, 2026-07-24) is deliberately NOT an entry: it carries no scalar level
  // cut (thresholds {} — the bespoke merged scoreOil: a 20d-ROC band admitted by a trailing-peak
  // level GATE, both descriptor-resident and neither a classify() level cut — the G1
  // class), so levelCutIds() excludes it and the bijection test forbids a key here. The Stage-3
  // session was network-blocked anyway; if BRENT ever gains a classify() level cut, commit
  // dcoilbrenteu.csv + an assessment like the crisis-rung siblings above.
  F2:{ reason: "keyless FRED clamps BAMLC0A0CM to a rolling ~3y window — no fixture can outspan the guard window" },
  F10: { reason: "keyless FRED clamps BAMLEMCBPIOAS to a rolling ~3y window (796 rows, 2023-07-18→)" },
  CCC: { reason: "keyless FRED clamps BAMLH0A3HYC to a rolling ~3y window (the same ICE BofA clamp as F10)" },
};

/**
 * PINNED ids that are exempted, INDIVIDUALLY and with a reason — never a blanket skip, and
 * never a way to make a red suite green by fiat.
 *
 * **The precondition an entry is held to depends on where its cut comes from, and conflating
 * the two was a real defect (fixed 2026-07-20, review finding C1).** The original single
 * precondition — "`regimeStates` takes more than one value over the seed depth" — is a real
 * test for a **registry-absolute** id (EBP): its cut is a fixed hand-typed number, so whether
 * the series reaches it over 15 years is a genuine question with a genuine no answer. For a
 * **`synthPriors` id (F3)** the same clause is TAUTOLOGICAL: the live cut IS the p85/p95 of
 * that very window (`computeSynthCuts` = `expandingPercentile(...).at(-1)` over the history
 * `assessDrift` trims to the id's own seed depth), so ~15% of the scored observations sit at or above
 * amber BY CONSTRUCTION and `regimeStates.length > 1` can never be false. Demonstrated: append
 * five years of `NFCIRISK` decaying to -2.0 — far past anything historic, exactly the
 * "percentile ratchets down with the regime" case — and the clause still reports
 * `["GREEN","AMBER","RED"]`. It could not revoke for the one entry it was written for.
 *
 * So synth entries carry a SECOND precondition that the percentile does not fix:
 * **`lastCrossing` must fall in the recent half of the fitting window.** An expanding
 * percentile pins the SHARE of exceedances, never WHEN they occur — a series decaying out of
 * its own regime puts every exceedance at the old end and leaves the recent half untouched.
 * Under the decaying-`NFCIRISK` scenario this revokes; today F3 clears it with ~5 years of
 * slack (last crossing 2023-06-30 against a 2018-07-10 midpoint). The bound is parameter-free
 * (half the window, not a tuned constant) and it degrades the way an exemption should: as the
 * fixture is refreshed forward the midpoint advances while a dead cut's last crossing does
 * not, so a stale exemption expires on its own.
 *
 * Reverting W1 slice 2 (F3's `CALIB_MAP` entry) still fails HERE rather than slipping through
 * the allowlist, and now through the non-tautological door: off the seam F3 resolves the dead
 * 0.5/1.0 registry prior, is GREEN across all 15 years, has NO crossing at all, and both
 * preconditions fail.
 */
export const DRIFT_CALM_ALLOWLIST: Readonly<Record<string, string>> = {
  // F3 — ON the percentile seam since W1 slice 2, and alive there: its measured cut ≈ -0.337
  // amber / -0.172 red is crossed as recently as 2023-06-30, so the indicator CAN signal. The
  // trailing 3 years are simply a calm credit regime whose maximum (-0.346) sits 0.009 below
  // the amber cut. Knife-edge, not dead — and the recent-half crossing assertion is what tells
  // those two apart (the regime-states clause cannot; see the docblock). NOT a licence to leave
  // it unwatched: if the expanding percentile keeps ratcheting down with the regime, the
  // crossings stop landing in the recent half and this exemption revokes itself.
  F3: "on the percentile seam and crossed within the recent half of its fitting window (last non-GREEN 2023-06-30); trailing 3y is a calm regime topping out 0.009 below amber",
  // ⚠ EBP's entry was REMOVED 2026-07-29. It exempted EBP as a crisis-only indicator whose
  // PUBLISHED `credit/ebp_*` EVT cut (amber ≈ 1.0227) was SUPPOSED to sit above calm-regime
  // maxima — "last crossed in the 2020 spike". The `[USER]` retune closed that routing
  // (`CALIB_MAP.EBP.evtLevel: false`) and hand-set a far more sensitive registry pair, so EBP
  // now reports MOVES on its own and needs no exemption; leaving the entry would have left a
  // false claim about which cut is live standing in config. The evidence behind it is NOT void
  // and is preserved here in case a future EBP cut goes back above the calm regime: the
  // calm-regime tercile event study ran 2026-07-21 (`npm run probe:event-study -- --probe=ebp`)
  // and found NO tercile PASS on any EXACT leg in the damage direction — every cell PLACEBO-FAILs
  // (e.g. Semis T3@20 excess −0.87pp vs placebo-max 1.21pp, ratio 0.71; EM T3@20 −0.79 vs 0.42,
  // ratio 1.88), across ~46/69/43 calm months in T1/T2/T3.
};

export type DriftStatus = "MOVES" | "PINNED" | "UNOBSERVABLE";

export interface DriftAssessment {
  id: string;
  label: string;
  series: string;
  status: DriftStatus;
  /** Set on UNOBSERVABLE only — the feed property that makes the question unanswerable. */
  reason?: string;
  /** The cuts the notify path would actually use, resolved through the real seam. */
  cuts: CalibrationCuts;
  /**
   * Where the live cut came from: the runtime percentile seam, a published `calibration.json`
   * vintage row, or nothing measured at all (so `classify` falls back to the registry absolute).
   */
  cutSource: "synth-percentile" | "published-vintage" | "registry-absolute";
  /**
   * The registry thresholds, reported alongside `cuts` because they are NOT inert: the `op`
   * leg falls back to them (`legBounds`' `op ?? t.amberLevel`), so a hand-typed absolute can
   * pin an id that also carries measured `evt*` cuts. That is exactly how F9 stayed RED with
   * a healthy percentile beside it — a report showing only `cuts` would hide the culprit.
   */
  // `Thresholds` is no longer all-scalar since 2026-08-08 (`velocitySigma` is a nested config
  // object, not a cut), so this report field takes the whole shape rather than an index signature
  // that would exclude it. It is JSON-dumped verbatim below; a nested member prints fine.
  priors: Thresholds;
  windowStart: string;
  windowEnd: string;
  nObs: number;
  /** Distinct raw states observed across the window, in first-seen order. */
  states: State[];
  /**
   * The same distinct-state reduction over the WIDER per-id seed-depth regime window — the
   * liveness evidence the allowlist is conditioned on. More than one value ⇒ the live cut is
   * reachable by this series and a constant 3y is calm; exactly one ⇒ the cut is dead across
   * the whole modern regime, which no exemption may cover.
   */
  regimeStates: State[];
  /**
   * Midpoint of the seed-depth regime window — the boundary the synth-id allowlist
   * precondition is stated against ("crossed in the RECENT half of its own fitting window").
   */
  regimeMid: string;
  /**
   * Date of the LAST non-GREEN scored day inside the regime window, or `undefined` if the cut
   * was never crossed there. Unlike `regimeStates` this is NOT fixed by the expanding
   * percentile: the percentile pins how MANY observations exceed the cut, never WHEN — so this
   * is the one liveness signal a synth id cannot satisfy by construction.
   */
  lastCrossing?: string;
  min: number;
  max: number;
}

/** Parse a committed `date,value` fixture, oldest→newest, skipping blank/`.` values. */
export function readFixture(relPath: string): Observation[] {
  const body = readFileSync(join(REPO_ROOT, relPath), "utf8").trim().split("\n").slice(1);
  const out: Observation[] = [];
  for (const line of body) {
    const [date, raw] = line.split(",");
    const value = Number(raw);
    if (date && raw !== undefined && raw !== "." && Number.isFinite(value)) out.push({ date, value });
  }
  return out;
}

/** `iso` shifted back `years` years — the window anchor arithmetic, one place. */
function minusYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return isoDay(d);
}

/**
 * Assess ONE indicator against its committed history.
 *
 * The synth-id history is trimmed to the id's OWN seed depth (`backfillDepthFor` — F3's 15y
 * override, not the shared 3y default) because that is the depth the live store carries —
 * feeding the guard a 45-year fixture would compute a percentile production never sees, and
 * the guard would then be testing a cut that does not exist.
 */
export function assessDrift(indicator: Indicator, observations: Observation[]): DriftAssessment {
  const depth = backfillDepthFor(indicator.id);
  // USER ruling 2026-09-05 (backfill-depth-3y §Opens): the regime window IS the seed depth —
  // for a default-depth id no wider than the drift window — so a registry-absolute id that is
  // calm across its whole store cannot be allowlisted. Accepted as the guard's intent (a fixed
  // cut with no wider evidence is exactly what it flags); no fixture-length floor for non-synth ids.
  const windowEnd = observations.at(-1)!.date;
  const regimeYears =
    "years" in depth ? depth.years : "days" in depth ? depth.days / 365 : (Date.parse(windowEnd) - Date.parse(depth.since)) / (365 * 86_400_000);
  const windowStart = minusYears(windowEnd, DRIFT_WINDOW_YEARS);
  const regimeStart = "since" in depth ? depth.since : minusYears(windowEnd, regimeYears);
  const regimeMid = minusYears(windowEnd, regimeYears / 2);
  const base = {
    id: indicator.id,
    label: indicator.label,
    series: indicator.series,
    windowStart,
    windowEnd,
    regimeMid,
  };

  // The live cut, built the way `confirmers.scoreWithCuts` builds it: the PUBLISHED vintage
  // (legacy shared rows — see `loadPublishedVintage`), routed through the synth seam.
  const storeDepth = observations.filter((o) => o.date >= regimeStart);
  const histories = new Map([[indicator.id, storeDepth.map((o) => o.value)]]);
  const calib = synthesizedCalib(indicator, loadPublishedVintage(), histories);
  const cuts = resolveCuts(indicator.id, calib, indicator.direction ?? "HIGH");
  const cutSource = hasSynthPriors(indicator.id)
    ? "synth-percentile"
    : Object.keys(cuts).length > 0
      ? "published-vintage"
      : "registry-absolute";

  const inWindow = observations.filter((o) => o.date >= windowStart);
  const levels = inWindow.map((o) => o.value);
  const stats = {
    ...base,
    cuts,
    cutSource,
    priors: { ...indicator.thresholds },
    nObs: inWindow.length,
    min: levels.length > 0 ? Math.min(...levels) : NaN,
    max: levels.length > 0 ? Math.max(...levels) : NaN,
  } as const;

  if (observations[0]!.date > minusYears(windowEnd, MIN_OBSERVABLE_YEARS)) {
    return {
      ...stats,
      status: "UNOBSERVABLE",
      reason: `history spans only ${observations[0]!.date}→${windowEnd}, short of the ${MIN_OBSERVABLE_YEARS}y a ${DRIFT_WINDOW_YEARS}y window needs`,
      states: [],
      regimeStates: [],
    };
  }

  // The real per-day fold. `rawStateSeries` aligns to `observations[VELOCITY_WINDOW..]`, so
  // the dates line up by construction — each window is sliced off the ALIGNED dates, never
  // off the raw ones (an off-by-VELOCITY_WINDOW here would silently widen the window).
  const raw = rawStateSeries(indicator, observations, cuts);
  const alignedDates = observations.slice(VELOCITY_WINDOW).map((o) => o.date);
  const distinctFrom = (from: string): State[] => {
    const seen: State[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (alignedDates[i]! < from) continue;
      if (!seen.includes(raw[i]!)) seen.push(raw[i]!);
    }
    return seen;
  };
  const states = distinctFrom(windowStart);
  const regimeStates = distinctFrom(regimeStart);
  // Last non-GREEN day inside the regime window — the WHEN the percentile leaves free.
  let lastCrossing: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    if (alignedDates[i]! < regimeStart) continue;
    if (raw[i] !== "GREEN") lastCrossing = alignedDates[i];
  }
  return {
    ...stats,
    status: states.length > 1 ? "MOVES" : "PINNED",
    states,
    regimeStates,
    lastCrossing,
  };
}

/** The full sweep, in `DRIFT_FIXTURES` order. */
export function assessAll(): DriftAssessment[] {
  const byId = new Map(ALL_INDICATORS.map((i) => [i.id, i]));
  return Object.entries(DRIFT_FIXTURES).map(([id, fixture]) => {
    const ind = byId.get(id);
    if (!ind) throw new Error(`DRIFT_FIXTURES names ${id}, which is not in ALL_INDICATORS`);
    if (typeof fixture !== "string") {
      return {
        id,
        label: ind.label,
        series: ind.series,
        status: "UNOBSERVABLE" as const,
        reason: fixture.reason,
        cuts: {},
        cutSource: "registry-absolute" as const,
        priors: { ...ind.thresholds },
        windowStart: "n/a",
        windowEnd: "n/a",
        regimeMid: "n/a",
        nObs: 0,
        states: [],
        regimeStates: [],
        min: NaN,
        max: NaN,
      };
    }
    return assessDrift(ind, readFixture(fixture));
  });
}

/**
 * Every id this drift class can reach: an `ALL_INDICATORS` entry carrying a scalar level cut,
 * i.e. one scored through `classify` rather than a bespoke scorer. Derived from the registry,
 * NOT hand-listed, so a new level-cut indicator is forced into `DRIFT_FIXTURES` (with either
 * a fixture or an explicit unobservable reason) instead of silently escaping the guard.
 */
export function levelCutIds(): string[] {
  return ALL_INDICATORS.filter(
    (i) =>
      (i.thresholds.amberLevel !== undefined || i.thresholds.redLevel !== undefined) &&
      // SMOOTHED-LEVEL ids are excluded, and NOT as a shortcut: `assessDrift` scores through
      // `rawStateSeries`, which applies the level pair to the DAILY close. The live scorer of R8 and
      // (since 2026-08-31) R1 applies it to a trailing MEAN, so an assessment here would grade a path
      // the phone never runs. Same resolution as F9/F11 leaving this map: the property is asserted
      // directly instead, in `src/dashboard.score-indicator.test.ts`, over the SAME committed
      // `t10y3m.csv` fixture through `smoothedLevelReadingSeries`.
      !SMOOTHED_LEVEL_OF[i.id],
  ).map((i) => i.id);
}

/** The actionable failure text — names the id, its live cuts, what the series actually did,
 * and the remedy that fixed F3/F11 (and F9, until it left the seam 2026-08-08). */
export function driftReport(a: DriftAssessment): string {
  const cuts = JSON.stringify(a.cuts);
  return (
    `${a.id} (${a.label}, ${a.series}) is PINNED ${a.states[0]} for the whole ` +
    `${DRIFT_WINDOW_YEARS}y window ${a.windowStart}→${a.windowEnd} (${a.nObs} obs).\n` +
    `  live cuts (${a.cutSource}): ${cuts}\n` +
    `  registry priors (the \`op\` leg's convention fallback — these can pin an id on their ` +
    `own): ${JSON.stringify(a.priors)}\n` +
    `  observed range over the window: ${a.min} … ${a.max}\n` +
    `  last crossing inside the seed-depth regime window (mid ${a.regimeMid}): ` +
    `${a.lastCrossing ?? "never"}\n` +
    `  REMEDY: an absolute cut the series can no longer cross is not a signal. Put the id on ` +
    `the runtime expanding-percentile seam — add a CALIB_MAP entry with synthPriors in ` +
    `src/domain-cuts.ts, as F3 is on its level axis and F11 on its velocity axis. ` +
    `Do NOT re-type fresh absolutes: that re-creates this class.`
  );
}
