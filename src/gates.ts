/**
 * Case 4 — generalized gate contract for indicators whose decision is NOT a
 * single-variable threshold cross (the compound AND-rules): the SINGLE source of
 * which named boolean conditions each compound id ships per point, consumed by
 * BOTH sides of the wire:
 *  - `api/indicators.ts buildChart` declares them on the chart spec
 *    (`ChartSpec.gates` + `ChartSeries.gatedBy` on the decision series);
 *  - `api/series.ts` recomputes each flag per point from stored history and
 *    attaches it as `SeriesPointDTO.gates`.
 * The generic renderer (public/detail-chart.js) then dims/dashes the gated
 * series where NO listed gate is on, so a non-firing band cross reads as
 * designed rather than as a broken ribbon. Replaces the F4-only `f4GateNote`
 * text hack. Both shipped layouts render gates: the derived-kind layout gates its
 * SECONDARY decision line, and `genericSingle` gates its PRIMARY line too (added
 * 2026-08-18 for the DB_* downside detectors, whose scored variable IS the primary
 * series — before it, a gated single-axis id emitted flags no layout drew).
 *
 * Parity note (why on-read recompute is exact): each stored F4/F8/NVDA series
 * starts at raw index MA_WINDOW−1 (buildReadings baseOffset), so for any stored
 * index k ≥ MA_WINDOW−1 the trailing MA over STORED values equals the scorer's
 * MA over the raw feed — `belowMAFlags` reproduces the live gate exactly wherever
 * it emits a flag, and emits `null` (= unknown, no flag on the wire) below that
 * depth. A cross-series gate (`source` ≠ "own") gets its MA computed over the
 * date-INTERSECTION of the aux series with the gated id's stored calendar
 * (api/series.ts gatedSeries), mirroring the scorer's alignByDate — the gated
 * id's stored calendar IS a suffix of that aligned calendar, so covered
 * cross-series flags are exact too. Pure: no IO.
 */
import { MA_WINDOW, DISP_CORR, MU_MA_MULT } from "./family-descriptor-rows.js";
import { levelGateOn, maxOf } from "./scorers-core.js";
import { G1_DESCRIPTOR, BRENT_DESCRIPTOR, NG_DESCRIPTOR, PRICE_WINDOWS } from "./family-descriptor-rows.js";

/**
 * Human suffix for a `maMult` headroom — `1.1` → "+10%", `0.95` → "−5%", `1` → "" (a bare
 * MA needs no qualifier). The ONE place a gate multiplier becomes display copy; both the
 * gate legend (below) and the drawn overlay's label (api/indicators.ts) read it, so the
 * number can only ever be written once (family-descriptor-rows.ts).
 */
export function maMultSuffix(m: number): string {
  if (m === 1) return "";
  const pct = (m - 1) * 100;
  return `${pct > 0 ? "+" : "−"}${Math.abs(Number(pct.toFixed(2)))}%`;
}

/** Fields every gate condition carries, whatever its rule shape. */
interface GateBase {
  /** wire key into `SeriesPointDTO.gates` (and `ChartSeries.gatedBy`). */
  key: string;
  /** human phrase for the chart legend, e.g. "MU below its 200-day MA +10%". */
  label: string;
  /** which band(s) this gate arms — legend copy only, not render logic. */
  appliesTo: "amber" | "red" | "both";
}

/**
 * One named gate condition of a compound-rule indicator — a DISCRIMINATED UNION on
 * `rule`, so each rule's own operands are required (no optional-field non-null
 * assertions at the consumer) and a cut gate CANNOT declare a cross-series source.
 * That last part is load-bearing, not tidiness: `api/series.ts gatedSeries` checks
 * `rule` BEFORE `source`, so a `{ rule: "atOrAboveCut", source: "NVDA" }` def would
 * silently read the GATED id's own values and ship confidently-wrong flags. Making
 * `source: "own"` the only inhabitable value on that arm turns it into a type error.
 */
export type GateDef =
  | (GateBase & {
      /** `belowMA` — value strictly below its trailing MA (×`maMult`; scorers-price.ts `<`). */
      rule: "belowMA";
      /** whose stored value series feeds the rule: "own" or another indicator id. */
      source: "own" | string;
      /** MA lookback in observations. */
      window: number;
      /**
       * Optional headroom on the MA line: the rule is `value < MA · maMult` (absent ⇒ 1,
       * the bare `< MA`). F8 ships 1.1 (MA200 +10%) from the scorer's `MU_MA_MULT`, so the
       * flag, the legend label and the drawn overlay all move with that one constant.
       */
      maMult?: number;
    })
  | (GateBase & {
      /** `atOrAboveCut` — value at/above a fixed cut (scorers-*.ts `>=`), no lookback. */
      rule: "atOrAboveCut";
      /** Cut gates read the gated id's OWN stored value — never a cross-series feed. */
      source: "own";
      /**
       * The RAW, UNMULTIPLIED cut. Every GateDef field is a static literal by design —
       * the consumer (api/series.ts gatedSeries) applies
       * `earlierCut(cut, true, resolveMultiplier(id))` at flag time, mirroring the
       * scorer's seam. Resolving here instead would freeze the multiplier at import
       * and go stale on a config change until redeploy.
       */
      cut: number;
    })
  | (GateBase & {
      /**
       * `atOrAboveRollingMax` — value at/above the trailing `window`-observation peak
       * EXCLUDING the point itself (`scorers-core.ts levelGateOn`, which this arm calls
       * rather than reimplements, so the flag and the scored gate are one expression).
       * The oil family's `level: "trailing-peak"` leg (G1/BRENT).
       */
      rule: "atOrAboveRollingMax";
      /** Trailing-peak gates read the gated id's OWN stored value — never a cross-series feed. */
      source: "own";
      /** Trailing-peak lookback in observations; supplied by the id's descriptor, never retyped. */
      window: number;
    });

/**
 * indicator id → its gate conditions. Only the compound-rule ids appear here:
 *  - F8 (scoreMemGate): ret6 band cross fires only while MU < MA200(MU)·MU_MA_MULT;
 *  - F4 (scoreSemis): amber additionally needs SMH < MA200(SMH), red additionally
 *    needs NVDA < MA200(NVDA) — the cross-series gate reads NVDA's stored history.
 *  - DISP (scoreDispersion): the drawn decision variable is the 20d BASKET RETURN
 *    (band at 0); which arm a falling basket lands in is decided by the mean
 *    pairwise correlation LEVEL, so each arm ships its own cut gate. Both arms
 *    share the identical basket condition, hence one band and two gates.
 *  - G1 / BRENT (scoreOil, `combine: "split"` since 2026-08-11, ex-`"and"`): the 20d return
 *    band cross reaches RED only while price is AT OR ABOVE its trailing `levelWindow` peak;
 *    AMBER fires off either leg alone, ungated. Added 2026-08-06 (R5)
 *    — this leg was deliberately
 *    kept OUT of GATES while it was an OR disjunct against a fixed $100 cut, because gates
 *    are AND-semantic and an OR leg would dim stretches that actually fire. Under `"split"`
 *    the binary at-peak flag is exactly the RED requirement, so it stays the drawn gate;
 *    the level leg's AMBER proximity rung is drawn as its own line (chart-rail.ts), not a gate.
 *    ⚠ OVX is the oil family's THIRD member and is deliberately absent: its velocity leg is
 *    an OR disjunct (`OVX_DESCRIPTOR.combine === "or"`), so the same argument that admits
 *    G1/BRENT excludes it — it draws as a second band, not a gate.
 *  - DB_SMH / DB_XLK (scoreDownsideBreak): the drawdown band cross (amber ≤−5%,
 *    red ≤−8%) fires only while the close is BELOW its 50-day MA. This is the one
 *    gate whose drawn line is NOT on the plotted axis: the detail chart plots the
 *    DRAWDOWN, not the price, so the MA50 is drawn in drawdown space as
 *    `SeriesPointDTO.gateLine` (`ma50 ÷ 63d-high − 1`, api/series.ts) — algebraically
 *    the same condition, since `close < ma50 ⟺ dd < gateLine` for a positive high.
 *    Added 2026-08-18 off a reported defect: prod 2026-08-17 showed DB_SMH GREEN at a
 *    −11.2% drawdown (past the −8% red cut) because SMH had crossed back above its
 *    MA50, and nothing on the chart said so.
 * FXH's multi-leg aux data already rides `havenLegs` (the pre-contract instance of
 * the same idea: extra per-point series the decision needs); its envelope IS the
 * drawable decision variable, so it declares no gate.
 */
export const GATES: Record<string, readonly GateDef[]> = {
  F8: [
    {
      key: "belowMA200",
      // "+10%" is DERIVED from MU_MA_MULT — never retyped, so a retune can't leave the copy stale.
      label: `MU below its 200-day MA ${maMultSuffix(MU_MA_MULT)}`,
      appliesTo: "both",
      source: "own",
      rule: "belowMA",
      window: MA_WINDOW,
      maMult: MU_MA_MULT,
    },
  ],
  F4: [
    { key: "smhBelowMA200", label: "SMH below its 200-day MA", appliesTo: "amber", source: "own", rule: "belowMA", window: MA_WINDOW },
    { key: "nvdaBelowMA200", label: "NVDA below its 200-day MA", appliesTo: "red", source: "NVDA", rule: "belowMA", window: MA_WINDOW },
  ],
  DISP: [
    // Redesign 2026-07-22: ONE correlation confirm gate for BOTH tiers (the AMBER/RED split
    // moved to the basket axis). `atOrAboveCut` uses `>=` (shared helper) while the predicate is
    // STRICT `> DISP_CORR`; they diverge only at corr EXACTLY 0.75, where this display gate dims
    // the line "on" but the ribbon colour (from the stored state) is GREEN. Display-only edge.
    { key: "corrAtOrAboveCut", label: "global correlation at/above its confirm cut", appliesTo: "both", source: "own", rule: "atOrAboveCut", cut: DISP_CORR },
  ],
  // `window` is READ from the descriptor, never retyped — a `levelWindow` retune moves the
  // scored gate, the on-read flag and the chart legend together (`indicator-loop.md` §A retune is a ONE-place edit).
  // `appliesTo: "red"` (`"split"`, 2026-08-11): the at-peak flag binds ONLY the RED rung —
  // AMBER fires off either leg alone, so a dimmed stretch can still score AMBER.
  G1: [
    {
      key: "atTrailingPeak",
      label: "WTI at/above its trailing 3-year peak",
      appliesTo: "red",
      source: "own",
      rule: "atOrAboveRollingMax",
      window: G1_DESCRIPTOR.scorer.constants.levelWindow,
    },
  ],
  BRENT: [
    {
      key: "atTrailingPeak",
      label: "Brent at/above its trailing 3-year peak",
      appliesTo: "red",
      source: "own",
      rule: "atOrAboveRollingMax",
      window: BRENT_DESCRIPTOR.scorer.constants.levelWindow,
    },
  ],
  NG: [
    {
      key: "atTrailingPeak",
      label: "Henry Hub at/above its trailing 3-year peak",
      appliesTo: "red",
      source: "own",
      rule: "atOrAboveRollingMax",
      window: NG_DESCRIPTOR.scorer.constants.levelWindow,
    },
  ],
  // The downside detectors' MA50 trend gate — `appliesTo: "both"`, because the scorer
  // ANDs it into the amber rung as well as the red one (`downsideBreakReadingSeries`).
  // Window + the "50-day" in the copy both compose off `PRICE_WINDOWS.maShort`, the same
  // constant the scorer reads, so a retune moves score, flag and legend together.
  // `source: "own"`: the gate is the detector's OWN close against its OWN MA — the stored
  // DB_* row carries that close as `value`, so `belowMAFlags` over the stored series is exact.
  DB_SMH: [
    {
      key: "belowMA50",
      label: `SMH below its ${PRICE_WINDOWS.maShort}-day MA`,
      appliesTo: "both",
      source: "own",
      rule: "belowMA",
      window: PRICE_WINDOWS.maShort,
    },
  ],
  DB_XLK: [
    {
      key: "belowMA50",
      label: `XLK below its ${PRICE_WINDOWS.maShort}-day MA`,
      appliesTo: "both",
      source: "own",
      rule: "belowMA",
      window: PRICE_WINDOWS.maShort,
    },
  ],
};

/**
 * Per-index "value strictly below its trailing `window`-obs mean (inclusive of i), scaled
 * by `maMult` (default 1 = the bare MA)"
 * flags, `null` where the window isn't fully covered (index < window−1). Strict `<`
 * matches the scorers' gate exactly. O(n) via a running sum.
 */
export function belowMAFlags(values: ReadonlyArray<number>, window: number, maMult = 1): (boolean | null)[] {
  // Derived from `maValues`, never a second running sum: a `belowMA` gate that DRAWS its line
  // (F4/F8's MA200 overlay, DB_*'s drawdown-space MA50) must compare against the exact number the
  // flag compared against, or a boundary day dims one way and draws the other.
  const mas = maValues(values, window, maMult);
  return mas.map((ma, i) => (ma == null ? null : values[i]! < ma));
}

/**
 * The trailing `window`-obs mean of `values` (inclusive of i), scaled by `maMult` — `null`
 * where the window isn't fully covered (index < window−1), matching `belowMAFlags` exactly.
 * O(n) via a running sum. The ONE owner of the MA a `belowMA` gate scores against; the flags
 * above and every drawn MA line read it.
 */
export function maValues(values: ReadonlyArray<number>, window: number, maMult = 1): (number | null)[] {
  const mas: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= window) sum -= values[i - window]!;
    if (i >= window - 1) mas[i] = (sum / window) * maMult;
  }
  return mas;
}

/**
 * The INCLUSIVE trailing `window`-obs high (the day itself counts) — the downside detectors'
 * own rolling high, delegating to the SAME `maxOf` seam `downsideBreakReadingSeries` uses for
 * both its `classify` and its `decision`, so a drawdown-space gate line divides by exactly the
 * denominator the plotted drawdown was computed with. `null` before full coverage.
 * ⚠ NOT `rollingMaxValues` above, which EXCLUDES the day itself (the trailing-peak gate's
 * definition): mixing the two would put the drawn line a shade off the scored one.
 */
export function inclusiveRollingMax(values: ReadonlyArray<number>, window: number): (number | null)[] {
  const v = values as number[];
  return values.map((_, i) => (i < window - 1 ? null : maxOf(v, i - window + 1, i)));
}

/**
 * Per-index "value at/above `cut`" flags. Inclusive `>=`, matching
 * `dispersionState`'s comparison exactly. Unlike the MA rules this needs no
 * lookback, so EVERY stored point gets a real boolean — there is no `null`
 * left-edge hole, and the return type is narrower to say so.
 */
export function atOrAboveCutFlags(values: ReadonlyArray<number>, cut: number): boolean[] {
  return values.map((v) => v >= cut);
}

/**
 * Per-index "value at/above the trailing `window`-obs peak, the point itself EXCLUDED" flags,
 * `null` where the lookback isn't fully covered (index < window). Delegates to the scorer's own
 * `levelGateOn` rather than restating its comparison, so the drawn gate and the scored gate are
 * one expression by construction.
 *
 * ⚠ Parity is NOT the F4/F8 shape, and the difference is deliberate. `levelGateOn` (this helper's
 * source) degrades to TRUE when its lookback underruns (`start < 0`), though the SCORED graded leg
 * (`levelGateState`) now degrades GREEN. On read we emit `null` instead: the wire convention is
 * that a missing key means "unknown, draw normally" (fail-safe, no grey), and shipping the helper's
 * degrade-to-ON here would paint a confident open gate over a stretch where nothing was established.
 * Guarding on `i < window` makes `levelGateOn`'s degrade branch unreachable from this function, so
 * every flag it DOES emit is computed over a full window and is exact against the scored RED rung.
 *
 * ⚠ The PRECONDITION is STORED DEPTH, not the fetch size. A visible point carries a real flag only
 * where the store actually holds `window` rows before it, i.e. where stored depth ≥ `window` +
 * `limit`; `api/series.ts gatedSeries` asking for `limit + pad` cannot manufacture rows that were
 * never recorded. `window` here is a MULTI-YEAR lookback (`OIL_LEVEL_WINDOW` observations) while a
 * young id can hold far less — BRENT was recorded at ~273 stored days — so on a short history the
 * leading (and possibly every) visible point emits `null`. That is the fail-safe end of the wire
 * convention above: a missing key reads "unknown, draw normally", so the line paints undimmed and
 * nothing is asserted about the gate. No backfill is implied — a shallow id simply draws no gate
 * shading until its history is deep enough to establish one.
 */
export function atOrAboveRollingMaxFlags(values: ReadonlyArray<number>, window: number): (boolean | null)[] {
  const arr = [...values];
  return arr.map((_, i) => (i < window ? null : levelGateOn(arr, i, window)));
}

/** The trailing PRIOR-`window` peak per index (the max `levelGateOn` compares against, exclusive
 *  of `i`) — the gate's drawn line. `null` where the window isn't fully covered, mirroring the
 *  flags above; `gates.test.ts` pins flag ≡ (value ≥ peak) so line and flag cannot drift. */
export function rollingMaxValues(values: ReadonlyArray<number>, window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window) return null;
    let peak = -Infinity;
    for (let j = i - window; j < i; j++) if (values[j]! > peak) peak = values[j]!;
    return peak;
  });
}
