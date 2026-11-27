/**
 * The confirm-fold layer — the confirmation folds (directional at the indicator
 * tier since the 2026-08-26 ruling) plus THE one per-day
 * scoring loop (`scoreDaySeries`) every raw-state / leg-attribution series is a
 * thin wrapper over. Top leaf of the `domain-*.ts` split (Stage 5c.4): it
 * imports `domain-legs` → `domain-cuts` → `domain-types`.
 *
 * Each indicator resolves to Green (0) / Amber (1) / Red (2) per
 * docs/bigtech-crash-dashboard-design-v4.md §4, then the confirmation fold
 * (v4 §6.1) is applied at the indicator's own tier. ⚠ Since the 2026-08-26 ruling
 * (batch-2 row 7, overturning IS-5's symmetric zero) that tier fold is DIRECTIONAL
 * (`asymConfirmedStateSeries`): a worse raw state confirms same-day, an improved one
 * stands down only after `CONFIRM_TIERS` (= 2) consecutive clean closes. The symmetric
 * fold survives on the LEG/position side, where
 * `danger-engine.ts` keeps its own CONFIRM_CLOSES = 2. Velocity thresholds are
 * still derived from the full FRED history each run — no persistence needed.
 */

import type {
  Direction,
  Indicator,
  Observation,
  State,
  Thresholds,
} from "./domain-types.js";
import { CONFIRM_CLOSES, STATE_RANK, VELOCITY_WINDOW } from "./domain-types.js";
import { at } from "./series-math.js";
import { calibratedZ, type CalibrationCuts } from "./domain-cuts.js";
import {
  cusumParams,
  evaluateLegs,
  foldFired,
  winningLeg,
  type LegSeverity,
} from "./domain-legs.js";

/** One confirmation-fold site: where its buffer comes from and how the test holds it honest. */
export interface FoldSite {
  /** Buffer in CLOSES actually passed at this site. 0 and 1 both mean same-day (the fold
   *  degenerates to the identity); the minimum run that can flip the output is `max(closes, 1)` —
   *  for the DIRECTIONAL `indicator` site that is the STAND-DOWN depth; escalation is 1 close. */
  readonly closes: number;
  /** The symbol a retune edits — where `closes` comes from at this site. */
  readonly via: "CONFIRM_TIERS" | "CONFIRM_CLOSES";
  /** `behaviour` = the test drives the site's live function and measures the flip depth.
   *  `constant` = the test only pins `via`'s value against `closes` (weaker: a hand-typed
   *  literal swapped in at the site would not be caught). */
  readonly checkedBy: "behaviour" | "constant";
  /** Repo-relative files carrying this site's fold CALLS. Union over the table must equal the
   *  set of files that call a fold primitive in the scope below — pinned by the test. */
  readonly files: readonly string[];
  /** Which series is folded here. */
  readonly folds: string;
}

/**
 * ANSWER KEY — every confirmation-fold SITE in the tree and the buffer it folds at.
 *
 * A *site* CHOOSES a buffer and hands it to a fold primitive (`confirmedSeries`,
 * `confirmedStateSeries`, `deriveConfirmedState`, `scoredDaySeries`, `winningLegSeries`,
 * `pensionConfirmBand`, `confirmedRegime`). A function that merely forwards its caller's
 * `closes` is a pass-through, not a site — the caller is the site.
 *
 * ⚠ **DATA ONLY — nothing folds through this table.** Every entry was read off the live code at
 * its site; no call site consumes it, and none should (the `foldState(series, site)` collapse was
 * declined: it crosses the danger engine's scoring paths, where a wrong fold silently moves the
 * board). The table is an answer key, and its test is the half that does the work —
 * `dashboard.fold.test.ts` §"FOLD_BY_SITE" drives each `behaviour` site's real code, measures the run
 * length it takes to flip, and goes red when a site's buffer moves without this table moving with
 * it. That test also pins COMPLETENESS: the set of files calling a fold primitive under `src/`,
 * `api/` and `scripts/backtest/` must equal the union of `files` below, so a NEW fold site
 * anywhere in that scope fails until it is named here. One-off measurement probes directly under
 * `scripts/` are deliberately outside that scope and outside this table — but they are NOT
 * unenumerated: the same test pins that residue set too (`OUT_OF_SCOPE_FOLD_CALLERS` in
 * `dashboard.fold.test.ts`), because a probe folding at a buffer nobody chose reads as production
 * behaviour in its output. Today it is three files, two of them at hardcoded literals.
 *
 * The shape of the answer: the INDICATOR layer folds DIRECTIONALLY (2026-08-26 ruling) — worse
 * same-day, improvement after `CONFIRM_TIERS` = 2 clean closes; every other site folds a STATE
 * SERIES symmetrically at `CONFIRM_CLOSES` = 2. `backtestHarness` is the entry that does not
 * follow from `CLAUDE.md`'s prose — the opt-in backtest harnesses fold INDICATOR state through
 * the SYMMETRIC 2-close fold, not the live directional tier.
 */
export const FOLD_BY_SITE = {
  indicator: {
    closes: 2,
    via: "CONFIRM_TIERS",
    checkedBy: "behaviour",
    files: ["src/scorers-core.ts", "api/series.ts", "src/lab-attribution.ts"],
    folds:
      "the per-indicator Green/Amber/Red state - directional (asymConfirmedStateSeries): worse confirms same-day, improvement stands down after the tier's clean closes",
  },
  pillarRegime: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "behaviour",
    files: ["src/danger-engine.ts"],
    folds: "the per-leg 2×2 EW×SN pillar regime (`confirmedRegime`)",
  },
  bottom: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "behaviour",
    files: ["src/bottom.ts"],
    folds: "the off-ladder `BottomState` series",
  },
  pension: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "behaviour",
    files: ["src/pension.ts"],
    folds: "the blended-portfolio `PensionBand` series",
  },
  slowCalm: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "behaviour",
    files: ["src/slow.ts"],
    folds: "the slow track's duration-of-calm raw-state series",
  },
  calibrationReplay: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "behaviour",
    files: ["scripts/backtest/replay.ts"],
    folds: "vintage per-indicator state, the reads that produce `CALIB_MAP`",
  },
  backtestHarness: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "constant",
    files: [
      "scripts/backtest/event-study.ts",
      "scripts/backtest/f1-percentile-cuts.ts",
    ],
    folds:
      "opt-in backtest-harness INDICATOR state at the symmetric 2-close buffer - NOT the live directional tier",
  },
  foldPrimitiveDefault: {
    closes: 2,
    via: "CONFIRM_CLOSES",
    checkedBy: "constant",
    files: ["src/domain-fold.ts"],
    folds: "the `confirmCloses` DEFAULT on `scoredDaySeries`/`winningLegSeries` - every live caller passes explicitly",
  },
} as const satisfies Record<string, FoldSite>;

/**
 * Dual-threshold, recall-first (threshold-provenance plan): a day fires a severity
 * when ANY of its OR-legs fires (Decision 1) — RED checked before AMBER. The measured
 * legs only ADD firings: an absent `cuts` leg or `z` leaves the absolute behavior
 * exactly as-is (Decision 2), so `classify(l, d, t, dir)` with no calibration is
 * byte-identical to convention-only. Leg semantics → `evaluateLegs`.
 *
 * "ANY leg fires" is the DEFAULT fold, not the only one: the combination rule lives in the one
 * shared `foldFired` (domain-legs.ts) that `winningLeg` also reduces through, and an indicator
 * carrying a `cuts.fold` policy (`FOLD_POLICY`, domain-cuts.ts) may require ALL its present legs
 * at a severity instead. Absent policy ⇒ the shipped `.some()` semantics verbatim.
 */
function classify(
  level: number,
  delta20: number,
  t: Thresholds,
  direction: Direction,
  cuts?: CalibrationCuts,
  z?: number,
  velZ?: number,
  cusum?: number,
  velZFast?: number,
): State {
  const fires = (sev: LegSeverity) =>
    foldFired(
      evaluateLegs(sev, level, delta20, t, direction, cuts, z, velZ, cusum, velZFast),
      sev,
      cuts?.fold,
    ).length > 0;
  if (fires("Red")) return "RED";
  if (fires("Amber")) return "AMBER";
  return "GREEN";
}

/**
 * Confirmed state AS OF each day (running SYMMETRIC confirm fold at `closes`), oldest→newest.
 * Same fold as the scalar `deriveConfirmedState` — a candidate state is adopted only once it
 * has appeared on `closes` consecutive closes — but it KEEPS every intermediate
 * step instead of returning only the last. This is the series-as-primitive root
 * for the CONFIRM_CLOSES callers
 * (slow.ts, the backtest harness); the INDICATOR tier folds through the directional
 * `asymConfirmedStateSeries` below since the 2026-08-26 ruling.
 *
 * Invariant: `confirmedStateSeries(rs, c).at(-1) === deriveConfirmedState(rs, c)`
 * for all non-empty `rs` (characterization + property tests lock this). The
 * bootstrap value (rawStates[0]) washes out over a long history, so the latest
 * confirmed state is deterministic regardless of where we start.
 */
export function confirmedStateSeries(rawStates: State[], closes: number): State[] {
  return confirmedSeries(rawStates, closes);
}

/**
 * The confirmation fold, generic over any equatable label `T`. The fold is
 * pure equality + run-length — it NEVER reads `STATE_RANK` — so it is identical for
 * the fast `State`, the off-ladder `BottomState`, and the `PensionBand` enums; the
 * three tracks share this one audited implementation rather than each carrying a
 * copy (/qimpag 2026-06-29). `confirmedStateSeries`
 * is the `State` specialization; `bottom.ts` / `pension.ts` fold their own band
 * enums directly. `T` must be a primitive or string-literal union — equality is `===`,
 * so an object-typed `T` would get reference (not structural) equality. A candidate
 * label is adopted only once it has held for `closes`
 * consecutive closes; the bootstrap value (`rawStates[0]`) washes out over a long
 * history, so the latest confirmed label is deterministic regardless of start.
 * `closes ≤ 1` degenerates to the identity (every candidate has trivially held).
 * Live for the LEG-level regime fold and the off-ladder BottomState/PensionBand tracks
 * (CONFIRM_CLOSES=2); the INDICATOR tier folds through the DIRECTIONAL
 * `asymConfirmedStateSeries` instead (2026-08-26 ruling), never this symmetric fold.
 */
export function confirmedSeries<T>(rawStates: T[], closes: number): T[] {
  if (rawStates.length === 0) throw new Error("confirmedSeries: empty history");
  const out: T[] = [];
  let confirmed = at(rawStates, 0); // bootstrap (washes out — same as the scalar fold)
  for (let i = 0; i < rawStates.length; i++) {
    if (i >= closes - 1) {
      const candidate = at(rawStates, i);
      if (candidate !== confirmed) {
        let held = true;
        for (let j = i - closes + 1; j <= i; j++) {
          if (rawStates[j] !== candidate) {
            held = false;
            break;
          }
        }
        if (held) confirmed = candidate;
      }
    }
    out.push(confirmed);
  }
  return out;
}

/**
 * Latest confirmed state — the last element of `confirmedStateSeries` (shared
 * definition, no drift). The bootstrap value washes out over a long history, so
 * the latest confirmed state is deterministic regardless of where we start.
 */
export function deriveConfirmedState(rawStates: State[], closes: number): State {
  return confirmedStateSeries(rawStates, closes).at(-1)!;
}

/**
 * DIRECTIONAL State fold — THE indicator-tier fold since the 2026-08-26 ruling (batch-2 row 7):
 * a raw state ranking WORSE (`STATE_RANK`) than the running confirmed state is adopted same-day;
 * an improved one is adopted only once it has held `downCloses` consecutive closes (same
 * run-length semantics as `confirmedSeries`; mixed improved labels never accumulate a run).
 * `downCloses ≤ 1` degenerates to the identity; bootstrap = `rawStates[0]`, washing out like the
 * symmetric fold. State-only by design — it reads `STATE_RANK`, so the generic symmetric
 * `confirmedSeries<T>` stays the fold for the leg-regime / off-ladder / backtest callers.
 */
export function asymConfirmedStateSeries(rawStates: State[], downCloses: number): State[] {
  if (rawStates.length === 0) throw new Error("asymConfirmedStateSeries: empty history");
  const out: State[] = [];
  let confirmed = at(rawStates, 0); // bootstrap (washes out — same as the symmetric fold)
  for (let i = 0; i < rawStates.length; i++) {
    const candidate = at(rawStates, i);
    if (STATE_RANK[candidate] > STATE_RANK[confirmed]) {
      confirmed = candidate; // instant escalation — worse confirms same-day
    } else if (candidate !== confirmed && i >= downCloses - 1) {
      let held = true;
      for (let j = i - downCloses + 1; j <= i; j++) {
        if (rawStates[j] !== candidate) {
          held = false;
          break;
        }
      }
      if (held) confirmed = candidate; // stand-down — improved held downCloses closes
    }
    out.push(confirmed);
  }
  return out;
}

/**
 * Per-day velocity delta `v[i] - v[i - window]`, aligned to `values[window..]`
 * (so index `k` here is observation `k + window`). The live velocity formula,
 * extracted so the backtest constants emitter can publish a fixture computed by
 * the REAL source rather than a hand re-encode (D0 Stage 2.1). ABSOLUTE only — the fold scores
 * `velocityDeltaAt` below, which equals this at every `i ≥ window` for an id without `velocityMode`.
 */
export function velocityDelta(values: number[], window: number = VELOCITY_WINDOW): number[] {
  const deltas: number[] = [];
  for (let i = window; i < values.length; i++) deltas.push(at(values, i) - at(values, i - window));
  return deltas;
}

/** THE scored + persisted `delta20` at `values[i]`: Δ over `velocityWindow ?? VELOCITY_WINDOW`, base
 *  clamped to `values[0]`; `velocityMode: "relative"` ⇒ the Δ as a fraction of that base. */
export function velocityDeltaAt(
  values: readonly number[],
  i: number,
  ind: Pick<Indicator, "id" | "velocityWindow" | "velocityMode">,
): number {
  const base = at(values, Math.max(0, i - (ind.velocityWindow ?? VELOCITY_WINDOW)));
  const d = at(values, i) - base;
  if (ind.velocityMode !== "relative") return d;
  if (!(base > 0)) throw new Error(`[${ind.id}] relative velocity needs a positive base, got ${base}`);
  return d / base;
}

/**
 * TRADING DAYS of history `velocitySigmaZSeries` needs — the ONE source every read site sizes off
 * (`velocitySigmaFetchOpts` in fred.ts, `lookbackPadFor` in api/series.ts, `legHistoryLimitFor` in
 * src/lab-assembly.ts) — a FOURTH depth formula is the defect. It equalises the MINIMUM depth, not the array
 * (a calendar `since` vs a row count differ in length, and the EWMA arm is path-dependent on it), so
 * the two σ reads leave a BOUNDED residual — under 0.1% by the `10 ×` rule below — never zero.
 *
 * ⚠ `window` alone is WRONG for a blended id. The rect arm is windowed but the EWMA arm is an
 * UNBOUNDED recursion over whatever the caller hands in, so a short read leaves its seed weighted
 * `2^-(obs/halfLife)` at the scored day. `10` half-lives puts that under 0.1%; measured 2026-08-10,
 * F11 read at `window + w` = 564 obs printed σ 5.44% under its full-history value.
 * Add the caller's own `velocityWindow` on top — a Δw consumes `w` leading observations.
 */
export function velocitySigmaDepth(cfg: { window: number; ewmaHalfLife?: number }): number {
  return Math.max(cfg.window, 10 * (cfg.ewmaHalfLife ?? 0));
}

/**
 * ROLLING-σ STANDARDIZATION of the velocity axis.
 * Returns `{ sigma, z }`, both aligned to `values[VELOCITY_WINDOW..]`
 * exactly like the fold below and like `ProxyLegSeries` — index `k` is observation
 * `k + VELOCITY_WINDOW`.
 *
 * `z = Δw / σ` (NOT mean-centred — the ruled formula; the level of the dollar's drift is
 * signal here, only its SCALE is regime-dependent). σ is the sample standard deviation of
 * the same Δw quantity over a **strictly historical** window of observation indices
 * `[i − cfg.window, i − 1]`: the scored day's own delta is excluded, so today can never
 * shrink the σ that judges it. Fewer than `cfg.minObs` usable deltas in that window, or a
 * degenerate σ ≤ 0, ⇒ BOTH entries are `undefined` — the day DEGRADES (the `vel-z` leg
 * simply does not fire) rather than scoring off a thin or zero scale.
 *
 * ⚠ `cfg.window` is a CAP, not a promise — see `Thresholds.velocitySigma`.
 *
 * ⚠ THE TWO ARMS ARE DIFFERENT STATISTICS: rect is a mean-CENTRED sample sd, the EWMA an UNCENTRED
 * RMS of Δw (matching the uncentred z) — so a drift regime alone moves the bind share, no knob moving.
 *
 * O(n) via prefix sums over the delta series, because the backtest harness re-folds this
 * per as-of point; a naive per-day window scan would be O(n·window) inside that loop.
 */
export function velocitySigmaZSeries(
  values: number[],
  w: number,
  cfg: { window: number; minObs: number; ewmaHalfLife?: number; ewmaFloorFactor?: number },
): { sigma: Array<number | undefined>; z: Array<number | undefined> } {
  const n = values.length;
  // `delta(j)` for observation index j, defined only for j ≥ w (a genuine w-step change —
  // the fold's head CLAMP is a scoring convention, never an observation of the Δw
  // distribution, so it must not enter σ). Prefix sums are over j = w..n−1, offset by w.
  const m = Math.max(0, n - w);
  const sum = new Float64Array(m + 1);
  const sumSq = new Float64Array(m + 1);
  for (let k = 0; k < m; k++) {
    const d = at(values, k + w) - at(values, k);
    sum[k + 1] = at(sum, k) + d;
    sumSq[k + 1] = at(sumSq, k) + d * d;
  }
  // OPT-IN EWMA ARM (`Thresholds.velocitySigma.ewmaHalfLife`): σ = max(ewma, floor × rect), and the
  // EWMA alone where rect degrades. Absent ⇒ the rectangular path below runs unchanged.
  const halfLife = cfg.ewmaHalfLife;
  const lambda = halfLife === undefined ? 0 : 1 - Math.pow(0.5, 1 / halfLife);
  const floorFactor = cfg.ewmaFloorFactor ?? 0;
  let ewmaS2: number | undefined;
  let ewmaCount = 0;
  const sigma: Array<number | undefined> = [];
  const z: Array<number | undefined> = [];
  for (let i = VELOCITY_WINDOW; i < n; i++) {
    // Historical delta indices j ∈ [max(w, i − cfg.window), i − 1] ⇒ prefix offsets [a, b).
    const a = Math.max(0, i - cfg.window - w);
    const b = Math.max(0, i - w); // EXCLUSIVE ⇒ ends at j = i − 1, never the scored day
    const count = b - a;
    let rect: number | undefined;
    if (count >= cfg.minObs) {
      const s = at(sum, b) - at(sum, a);
      const q = at(sumSq, b) - at(sumSq, a);
      const variance = (q - (s * s) / count) / (count - 1);
      const sd = variance > 0 ? Math.sqrt(variance) : 0;
      if (sd > 0) rect = sd;
    }
    let scale = rect;
    if (halfLife !== undefined) {
      if (i - 1 >= w) {
        const d = at(values, i - 1) - at(values, i - 1 - w);
        ewmaS2 = ewmaS2 === undefined ? d * d : lambda * d * d + (1 - lambda) * ewmaS2;
        ewmaCount++;
      }
      const e = ewmaCount >= cfg.minObs && ewmaS2 !== undefined && ewmaS2 > 0 ? Math.sqrt(ewmaS2) : undefined;
      scale = e === undefined ? undefined : rect === undefined ? e : Math.max(e, floorFactor * rect);
    }
    if (scale === undefined) {
      sigma.push(undefined);
      z.push(undefined);
      continue;
    }
    // The SCORED delta — identical to the fold's `delta20`, head clamp included, so the
    // standardized quantity is the same number the card and the persisted row carry.
    const delta = i - w >= 0 ? at(values, i) - at(values, i - w) : at(values, i) - at(values, 0);
    sigma.push(scale);
    z.push(delta / scale);
  }
  return { sigma, z };
}

/**
 * THE ONE-SIDED CUSUM ACCUMULATOR over a z series
 * (the SAME z the `vel-z` speed leg scores, never a second standardization).
 *
 * `S⁺_t = max(0, S⁺_{t−1} + z_t − k)`: a drift of less than `k` σ per step decays the
 * accumulator to zero, so a reversal resets it and only PERSISTENT one-sided drift builds. The
 * `vel-cusum` leg is TWO-TIER over `S⁺` — AMBER at the warning limit, RED at the action limit
 * (`legBounds`, domain-legs.ts). This is what the retired LEVEL leg was reaching for and got wrong
 * by thresholding an absolute level on a trending index.
 *
 * ⛔ **FIR RESTART AT THE ACTION LIMIT** (2026-08-11 `[USER]`; reset point at the RED bound and
 * restart value raised 0 → `h/2`
 * per Lucas & Crosier 1982). The day `S⁺` reaches the action limit the accumulator is EMITTED and
 * then set to `h/2`, so that day still scores RED, a persisting drift re-signals in ~half the
 * climb, and calm days (z < k) drain the head-start to 0 instead of holding a false alarm.
 * The bound arrives as the `h` argument,
 * resolved by callers through `cusumRedBound` — the single reader of the field, shared with
 * `legBounds` — so the reset can never disagree with the RED fire test. Resetting at the WARNING
 * limit instead (the pre-§3.6a shape) cut S⁺ down the moment it signalled, which made the action
 * limit unreachable except by one outsized step and left the drawn red line uncrossable.
 * The reset is also what BOUNDS the accumulator: without it the leg ratchets and S⁺ climbs
 * unbounded, with it S⁺ can never exceed the reset bound plus one step and every reset re-arms from
 * `h/2` (`src/dashboard.score-indicator.test.ts` pins both, derived from the registry constants).
 * ⛔ Every fire-rate / peak / episode / marginal-day figure this leg has ever been measured at is a
 * function of `k` AND of where the reset sits, and both moved on 2026-08-09 — so do not quote a
 * number from here, and none is retained: `docs/indicator-cut-provenance.md` §F9 keeps the constraints
 * that bind a retune, not the rates, and the live pair ships unmeasured by ruling.
 *
 * Output is index-aligned to the input `z` (hence to `observations[VELOCITY_WINDOW..]`), so the
 * day's scalar can be handed to the PURE `evaluateLegs` exactly as `velZ` is — statefulness
 * inside that function would let the state and its attribution disagree about the fold
 * (§Design constraint: keep `evaluateLegs` pure).
 *
 * DEGRADED DAYS (`z === undefined` — below the σ floor, or a degenerate σ): the day emits
 * `undefined`, so the leg cannot fire on a day whose z is unknown, and the running accumulator
 * is HELD rather than reset — an unknown step is not evidence of a reversal. Today those days
 * are exactly the contiguous warm-up head, where the accumulator is still 0, so the hold and a
 * reset are indistinguishable in production; the hold is stated so a future mid-series gap
 * behaves predictably.
 */
export function velocityCusumSeries(
  z: ReadonlyArray<number | undefined>,
  k: number,
  h: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = [];
  let s = 0;
  for (const zi of z) {
    if (zi === undefined) {
      out.push(undefined);
      continue;
    }
    s = Math.max(0, s + zi - k);
    out.push(s);
    // Emit FIRST, then restart: the reset day must still carry its `S⁺ ≥ h` value or `evaluateLegs`
    // would never see the firing it is resetting for. FIR head-start restart at h/2 (Lucas &
    // Crosier 1982): a persisting drift re-signals in ~half the climb; calm days decay it to 0.
    if (s >= h) s = h / 2;
  }
  return out;
}

/**
 * Raw (unconfirmed) state for every day we can compute velocity for (oldest ->
 * newest), aligned to `observations[VELOCITY_WINDOW..]`. Extracted so the
 * backtest harness (scripts/backtest/replay.ts) can fold the SAME per-day raw
 * states through `deriveConfirmedState` at each historical as-of point instead of
 * reimplementing the classify loop — single source of truth. No length guard:
 * callers that need the latest confirmed Reading use scoreIndicator (which keeps
 * the guard); the harness tolerates short windows.
 */
export function rawStateSeries(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
  proxy?: ProxyLegSeries,
): State[] {
  return scoreDaySeries(indicator, observations, calib, proxy, undefined, "rawStateSeries").rawStates;
}

/**
 * THE one per-day scoring fold (D3 Stage 2.0, §0 R1) — the single loop `rawStateSeries`
 * and `winningLegSeries` are thin wrappers over. It walks
 * `observations[VELOCITY_WINDOW..]` exactly once, computing each day's `level`,
 * `delta20` (from `velocityDeltaAt`) and inline velocity z, and reduces them through
 * `classify` to the raw state. Holding the loop, the z-alignment guard and the
 * `calibratedZ` call in ONE place makes leg-and-state agreement structural rather than
 * commented, and costs the leg path ONE `classify` pass instead of two (the previous
 * `winningLegSeries` called `rawStateSeries` and then re-walked the same loop).
 *
 * `attribution` is opt-in: when `undefined` (`rawStateSeries`' path) no confirmation
 * fold runs and `legs` comes back empty — load-bearing, because `confirmedSeries`
 * THROWS on an empty history and `rawStateSeries` must stay guard-free for the
 * backtest harness's short windows. When supplied, it carries the `confirmCloses` the
 * caller's tier fold uses, and the raw-vs-confirmed suppression gate is applied per day.
 *
 * `label` prefixes the alignment error so each wrapper's thrown message stays
 * byte-identical to the two copies this replaced.
 */
/**
 * The two per-day series a PROXY id (F1/F2) scored its borrowed credit legs against —
 * the Baa−10y LEVEL (`z`) and its velocity-window change (`velZ`), both in Baa10y units and both
 * aligned to `observations[VELOCITY_WINDOW..]`. Each is independently optional: an absent one
 * falls back to the own-series behaviour (own-level z / inline velocity z), which is what every
 * caller gets by passing nothing.
 *
 * ⚠ NO PRODUCTION CALLER SUPPLIES ONE SINCE 2026-08-06. The borrowed `z`/`vel-z` bounds for F1/F2
 * — the only two proxy ids — were retired that day, and Stage 5.2 then deleted the whole proxy-z
 * path: the producer, the `CALIB_MAP.{F1,F2}` rows and every fetch/branch feeding them.
 * This interface and the `proxy` parameter threaded
 * on top of it survive as the injection seam; every `src/` caller passes `undefined`, and since
 * 2026-09-05 NO constructor remains anywhere — the last, the frozen control arm in
 * `scripts/probe-f1f2-legs.ts` (which fed its own re-derived copy rather than this fold), was retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it).
 */
export interface ProxyLegSeries {
  z?: ReadonlyArray<number | undefined>;
  velZ?: ReadonlyArray<number | undefined>;
}

function scoreDaySeries(
  indicator: Indicator,
  observations: Observation[],
  calib: CalibrationCuts | undefined,
  proxy: ProxyLegSeries | undefined,
  attribution: { confirmCloses: number } | undefined,
  label: string,
): { rawStates: State[]; legs: Array<string | undefined>; rawLegs: Array<string | undefined> } {
  const direction = indicator.direction ?? "HIGH";
  // Both proxy arrays (when supplied by a wired caller) are aligned to the same
  // `observations[VELOCITY_WINDOW..]` slice we fold over, so index `i` maps to
  // `[i - VELOCITY_WINDOW]`. Absent ⇒ that leg skipped (absolute/EVT only).
  // Enforce the alignment so a Phase-3 off-by-one in the caller's per-day
  // construction fails loud instead of silently dropping the leg on the tail.
  const expectedZ = Math.max(0, observations.length - VELOCITY_WINDOW);
  // The day's delta is `velocityDeltaAt` (the persisted `delta20`); `w` is resolved once here
  // for the σ series below, which scores the ABSOLUTE Δ only (relative + σ throws).
  const values = observations.map((o) => o.value);
  const w = indicator.velocityWindow ?? VELOCITY_WINDOW;
  // The ROLLING-σ velocity z (any id declaring `Thresholds.velocitySigma`). Built here, so it
  // rides the SAME alignment guard as the proxy series below — and Stage 2's CUSUM folds the identical z.
  const sigmaCfg = indicator.thresholds.velocitySigma;
  if (sigmaCfg && indicator.velocityMode === "relative") {
    throw new Error(`${label}: [${indicator.id}] velocityMode "relative" has no σ path - velocitySigma scores the absolute Δ`);
  }
  // ⛔ PRECEDENCE GATE (review I5, 2026-08-08). The `velZ` selection below is an if/else chain,
  // so a proxy `velZ` would silently WIN over the σ z — while `legBounds` (domain-legs.ts) routes
  // off `thresholds.velocitySigma` alone and would still hand the σ-valued registry pair to
  // `vel-z`. The result is a units mismatch with no error: a published-zref z compared against a
  // σ multiple. The intersection is empty today (no production caller supplies a `ProxyLegSeries`
  // at all — see its docblock), so this makes the combination fail LOUD at the fold rather than
  // depend on that emptiness holding. `dashboard.score-indicator.test.ts` drives it.
  if (proxy?.velZ && sigmaCfg) {
    throw new Error(
      `${label}: [${indicator.id}] carries BOTH a proxy velZ series and thresholds.velocitySigma - ` +
        `the two put different units on the same \`vel-z\` leg; pick one`,
    );
  }
  const sigmaZ = sigmaCfg ? velocitySigmaZSeries(values, w, sigmaCfg).z : undefined;
  // THE FAST OR-ARM: a SECOND Δ horizon z'd by the same
  // estimator config, scored as `vel-z-fast` against the same σ pair. Knob absent ⇒ leg dark.
  const sigmaZFast =
    sigmaCfg?.fastWindow !== undefined
      ? velocitySigmaZSeries(values, sigmaCfg.fastWindow, sigmaCfg).z
      : undefined;
  // The CUSUM PERSISTENCE series (Stage 2), folded HERE — index-aligned to `sigmaZ` and so to
  // the same `observations[VELOCITY_WINDOW..]` slice — and passed into `evaluateLegs` one scalar
  // at a time. Built off `sigmaZ` (not a re-derived z), so the speed leg and the persistence leg
  // provably read the same standardized series.
  // Gated on the RESOLVED knob triple, not on `sigmaCfg` presence: a σ id that declines the
  // persistence leg (F11, ruling 5) folds no accumulator at all, so `evaluateLegs` receives an
  // undefined `cusum` on every day and the `vel-cusum` leg — whose bound `legBounds` also resolves
  // through `cusumParams` — can never fire.
  const cusumCfg = sigmaCfg ? cusumParams(sigmaCfg) : undefined;
  const sigmaCusum =
    sigmaZ && cusumCfg ? velocityCusumSeries(sigmaZ, cusumCfg.k, cusumCfg.red) : undefined;
  // ⚠ `sigmaZ` is deliberately NOT on this list. It is built HERE, by `velocitySigmaZSeries`, whose
  // loop pushes exactly `n − VELOCITY_WINDOW` entries — the same expression `expectedZ` computes —
  // so the branch could never fail and would read as a cleared guard while proving nothing
  // (review I6, 2026-08-08). The list guards series built by a CALLER, which is where an
  // off-by-one is actually reachable. The σ alignment is instead pinned by construction plus the
  // `expect(z).toHaveLength(RAMP_N - VELOCITY_WINDOW)` assertion in `dashboard.score-indicator.test.ts`.
  for (const [name, s] of [
    ["zSeries", proxy?.z],
    ["velZSeries", proxy?.velZ],
  ] as const) {
    if (s !== undefined && s.length !== expectedZ) {
      throw new Error(
        `${label}: ${name} length ${s.length} ≠ expected ${expectedZ} ` +
          `(must align to observations[VELOCITY_WINDOW..])`,
      );
    }
  }
  const rawStates: State[] = [];
  // Per-day scoring inputs, cached index-aligned to `rawStates` so the attribution
  // pass below re-uses them instead of re-deriving (and re-classifying) the loop.
  const days: {
    level: number;
    delta20: number;
    z: number | undefined;
    velZ: number | undefined;
    cusum: number | undefined;
    velZFast: number | undefined;
  }[] = [];
  for (let i = VELOCITY_WINDOW; i < observations.length; i++) {
    const level = at(observations, i).value;
    const delta20 = velocityDeltaAt(values, i, indicator);
    const z = proxy?.z?.[i - VELOCITY_WINDOW];
    // The velocity z-leg is own-series by default — computed inline off the day's delta20
    // + the published velocity reference (absent calib / missing velZref ⇒ undefined ⇒
    // classify skips the leg). A wired PROXY caller (F1/F2, 2026-07-23 `[USER]`) overrides
    // it with the Baa10y 30-day change, the units `resolveCuts` gave `velZAmber/velZRed`.
    // A `velocitySigma` id takes the ROLLING-σ z instead — same scalar seam, same
    // `vel-z` leg, but a strictly-historical own-series σ rather than a published `zref`.
    const velZ = proxy?.velZ
      ? proxy.velZ[i - VELOCITY_WINDOW]
      : sigmaZ
        ? sigmaZ[i - VELOCITY_WINDOW]
        : calibratedZ(delta20, calib?.velZrefMean, calib?.velZrefStd);
    // The day's CUSUM accumulator — a precomputed SERIES read positionally, never a running
    // variable threaded through `classify`, so the leg stays a pure per-day function.
    const cusum = sigmaCusum?.[i - VELOCITY_WINDOW];
    const velZFast = sigmaZFast?.[i - VELOCITY_WINDOW];
    rawStates.push(
      classify(level, delta20, indicator.thresholds, direction, calib, z, velZ, cusum, velZFast),
    );
    if (attribution !== undefined) days.push({ level, delta20, z, velZ, cusum, velZFast });
  }
  if (attribution === undefined) return { rawStates, legs: [], rawLegs: [] };
  // Short history (fewer than VELOCITY_WINDOW+1 observations) ⇒ no scored days at all. Return
  // BEFORE `asymConfirmedStateSeries`, which throws an id-less "asymConfirmedStateSeries: empty history".
  // Load-bearing: `indicatorReadingSeries` routes through here since Stage 2.0, and its caller
  // `buildReadings` has its own `rawStates.length === 0 → []` short-circuit whose informative
  // downstream error (`latest()`'s "[F1] need 22 observations, got 5") this preserves.
  if (rawStates.length === 0) return { rawStates, legs: [], rawLegs: [] };
  // Confirmed states (same raw series + DIRECTIONAL fold the ribbon uses — a symmetric fold here
  // would break the ribbon-vs-attribution agreement gate on stand-down cells).
  const confirmed = asymConfirmedStateSeries(rawStates, attribution.confirmCloses);
  const legs: Array<string | undefined> = [];
  // UNSUPPRESSED attribution: the leg off the RAW per-day inputs on EVERY day, including the
  // ≤confirmCloses boundary cells where `legs` blanks out. `legs` stays the ribbon's
  // agreement-gated series (a coloured cell is never mis-attributed); `rawLegs` is what a
  // PROVISIONAL push on an unconfirmed RED needs to name WHICH leg breached — exactly the
  // days `legs` is undefined by construction (2026-07-23 fast-credit plan, lever 2).
  const rawLegs: Array<string | undefined> = [];
  for (let k = 0; k < days.length; k++) {
    const d = at(days, k);
    const leg = winningLeg(
      d.level,
      d.delta20,
      indicator.thresholds,
      direction,
      calib,
      d.z,
      d.velZ,
      d.cusum,
      d.velZFast,
    );
    rawLegs.push(leg);
    // Raw disagrees with the confirmed (coloured) state ⇒ suppress — don't mis-attribute.
    if (rawStates[k] !== confirmed[k]) {
      legs.push(undefined);
      continue;
    }
    legs.push(leg);
  }
  return { rawStates, legs, rawLegs };
}

/**
 * Per-day winning OR-leg for every day we can compute velocity for (oldest→newest),
 * aligned to `observations[VELOCITY_WINDOW..]` — the `winningLeg` counterpart to
 * `rawStateSeries`, sharing its exact loop + z-alignment so leg and state can't drift.
 * Consumed only at the read-API edge (the ribbon tooltip); NOT persisted, so it lives
 * beside `rawStateSeries` rather than folding into the stored `Reading`.
 *
 * **Emitted only where raw agrees with confirmed** (/qimpag 2026-07-08): the ribbon
 * colours the CONFIRMED state, but `winningLeg` fires off the RAW per-day inputs. On the
 * boundary cells where the two disagree, the raw leg would mis-attribute the coloured cell (a
 * GREEN cell "via z-leg", or a RED cell via a receded leg), so it is suppressed there
 * (`undefined`) — the tooltip degrades to `date + state`, matching the served confirm-depth
 * note in the chart legend. ⚠ Under the directional fold (2026-08-26 ruling) the suppression
 * is LIVE on stand-down cells — days whose raw state has improved while the confirmed state
 * is still held worse. Uses the SAME `rawStateSeries` + z-alignment,
 * so leg/state can't drift.
 */
export function winningLegSeries(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
  proxy?: ProxyLegSeries,
  confirmCloses: number = CONFIRM_CLOSES,
): Array<string | undefined> {
  // Confirmation fold gated on agreement. Callers pass the indicator's tier fold
  // (`confirmClosesFor`, L1 Stage 4) — the default only covers legacy/slow callers; a
  // fast-tier indicator gated on the fixed fold would suppress attribution on exactly
  // the fresh-flip cells the ribbon now confirms and colours.
  return scoreDaySeries(indicator, observations, calib, proxy, { confirmCloses }, "winningLegSeries").legs;
}

/**
 * Both halves of the ONE fold in a single call — for the caller that needs the raw states
 * AND their per-day attribution (`indicatorReadingSeries`, D3 Stage 2.1). Calling
 * `rawStateSeries` + `winningLegSeries` would walk the series twice; this is the payoff
 * Stage 2.0's extraction was staged for. Same semantics as the two wrappers: `legs` is
 * index-aligned to `rawStates` and `undefined` wherever raw disagrees with confirmed.
 * `rawLegs` is the SAME series with the agreement gate removed — attribution on every day,
 * for the provisional (unconfirmed-RED) push path.
 */
export function scoredDaySeries(
  indicator: Indicator,
  observations: Observation[],
  calib?: CalibrationCuts,
  proxy?: ProxyLegSeries,
  confirmCloses: number = CONFIRM_CLOSES,
): { rawStates: State[]; legs: Array<string | undefined>; rawLegs: Array<string | undefined> } {
  return scoreDaySeries(indicator, observations, calib, proxy, { confirmCloses }, "scoredDaySeries");
}
