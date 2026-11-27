/**
 * Per-indicator AMBER/RED threshold tuning (see threshold-config.json). A config seam:
 * the scorer's committed priors are the base; config scales them at score time so a
 * sensitivity edit needs only a config change + redeploy, never a code change.
 *
 * Three knobs per indicator, per-leg-first precedence:
 *  - `amberMult` / `redMult` — PER-LEG scale of that band's constant. Any finite value;
 *    a NEGATIVE flips the band's sign, the only way to move a LOW-is-bad decline band
 *    up to a positive level (no live user since 2026-09-02) — and, being independent, lets
 *    amber land at a LARGER positive % than red so amber/red ordering is preserved (a
 *    single shared multiplier can't: it maps both legs by the same factor and inverts).
 *  - `multiplier` — shared fallback for BOTH legs when a per-leg value is absent.
 *    POSITIVE-only (zero / negative / non-finite → 1.0) so the 30-odd inert 1.0
 *    placeholders can never silently flip; use the explicit per-leg knobs to go negative.
 *
 * Statically imported (like config.json / geo.ts) — deterministic, no IO — so scorers-*.ts
 * stay pure. Leaf data file, not the registry: no import cycle.
 */
import cfg from "../threshold-config.json" with { type: "json" };

interface MultiplierEntry {
  label?: string;
  multiplier?: number;
  amberMult?: number;
  redMult?: number;
}
export interface ThresholdConfig {
  default?: number;
  multipliers?: Record<string, MultiplierEntry>;
}

const validPos = (m: unknown): m is number => typeof m === "number" && Number.isFinite(m) && m > 0;

/**
 * The engine-wide multiplier for `id`: the per-id `multiplier` override when present AND
 * positive-finite, else the top-level `default`, else 1.0. This is the value the whole
 * multiplier seam consumes — `resolveCuts` (measured cut legs, src/domain-cuts.ts),
 * `withMultipliedThresholds` (registry convention thresholds), and `resolveBands`' shared
 * fallback — so a config edit moves scoring, dial, ntfy and drawn bands together. Always a
 * finite positive number (never throws): a bad/absent override degrades to `default`, a bad
 * `default` degrades to 1.0. Per-leg `amberMult`/`redMult` (which may be negative) are the
 * raw sign-flip escape hatch and are NOT resolved here.
 */
export function resolveMultiplier(id: string, config: ThresholdConfig = cfg): number {
  const override = config.multipliers?.[id]?.multiplier;
  if (validPos(override)) return override;
  if (validPos(config.default)) return config.default;
  return 1.0;
}

/**
 * The direction-normalized earliness transform: `m < 1` moves EVERY cut representation to
 * fire EARLIER, `m > 1` later, regardless of the cut's sign or polarity. `firesHighward` =
 * "the leg fires when the variable rises to/through the bound" (read off the ACTUAL
 * comparator): a HIGH level / any velocity / any z-cut is highward; a LOW level (R1) is not.
 *
 *   earlier(v, firesHighward, m) = v − (firesHighward ? +1 : −1) · (1 − m) · |v|
 *
 * Monotone for any sign of `v` (the same `|v|` trick the retired `applyEarlyShift` used):
 * for a highward positive cut it reduces to `v · m`; a LOW cut moves the opposite way so a
 * smaller `m` lifts it UP toward the danger side. A zero cut is immovable (`|0| = 0`). At
 * `m = 1` it is the identity — the byte-parity guarantee for the shipped all-1.0 config.
 */
export function earlierCut(v: number, firesHighward: boolean, m: number): number {
  return v - (firesHighward ? 1 : -1) * (1 - m) * Math.abs(v);
}

/** `earlierCut` for an OPTIONAL cut — an absent (`undefined`) leg passes through untouched. */
export function earlierCutOpt(v: number | undefined, firesHighward: boolean, m: number): number | undefined {
  return v === undefined ? undefined : earlierCut(v, firesHighward, m);
}

/**
 * The REACHABLE set (Stage 2): ids whose SCORE path actually consumes a multiplier today —
 * every CALIB_MAP id + every id carrying non-empty `thresholds` + the two bespokes wired
 * through `resolveBands` (F8/F13 — F12 was a fourth until its 2026-07-17 retirement,
 * DEC-21; F6 dropped 2026-09-05, override-inert since the MA200 rescore). Hand-maintained here (a literal, so this file
 * stays a JSON-only leaf with no registry import → no cycle with domain-cuts.ts). A non-1.0
 * override on an id OUTSIDE this set is a silent no-op in prod, so `validateMultiplierConfig`
 * throws on it. EXTEND this set as Stage 3 wires each remaining bespoke scorer.
 */
// firesHighward per BESPOKE member (a HIGH value is the danger side ⇒ m<1 moves the cut DOWN): true = G1, VT,
// DISP, FXH; false = the other resolveBands/`bands:` members. CALIB/`thresholds` ids take direction from the registry.
export const REACHABLE_IDS: ReadonlySet<string> = new Set([
  // CALIB_MAP (measured cuts via resolveCuts)
  "F1", "F2", "R1", "R2", "R3", "R4", "R5", "EBP",
  // non-empty `thresholds` scored via classify()/scoreIndicator
  "F3", "F9", "F10", "F11", "R6",
  // bespoke scorers wired through resolveBands
  "F8", "F13", "EURGBP",
  // Stage 3.1 — derived-descriptor path (derivedRawStateSeries → resolveBands): G1/GT
  // (GT scored via the derived path though listed under 3.2 in the plan) + F4 semis
  // (semisReadingSeries → resolveBands). NVDA is deliberately EXCLUDED (Fix 3): its only
  // derived band is amber 0 (maSpread, immovable under the |v|-relative earliness form) and
  // red null — a non-1.0 NVDA override is a TOTAL no-op, so it must fail loud like F5, not
  // silently score unchanged. See docs/reference.md §[indicator] Bands & the threshold multiplier, skip list.
  // F6 is EXCLUDED the same way ([USER] 2026-09-05): its MA200 gate is amber null + red 0 — immovable
  // under |v|-form earlierCut / any redMult — so a non-1.0 F6 override must fail loud too.
  "G1", "GT", "F4",
  // Stage 3.2 — ratio/level/composite bespokes wired through resolveBands (CG/VT/EURC/GB/R7/
  // FXH + the DB_SMH/DB_XLK drawdown legs) and the two-cut DISP (earlierCut directly, not resolveBands).
  // ⚠ CG is reachable on its VELOCITY leg ONLY — an ASYMMETRIC SEAM, decided 2026-08-08 (R2),
  // not an oversight. Its 20d-return band routes through `resolveBands` like every other member
  // here; its second (LEVEL) leg — `CG_DESCRIPTOR.levelBand`, an expanding percentile of HG÷GC's
  // DEVIATION FROM ITS OWN TREND since 2026-08-08 (the `p` pair and the trend window live there
  // and nowhere else) — deliberately does NOT. The detrend did not change this seam, only what
  // the percentile is taken over: a percentile is already scale-free and self-recalibrating,
  // so there is no committed prior for a multiplier to scale: `earlierCut` would have to move a
  // PERCENTILE (a different quantile is a different question, not an earlier version of the same
  // cut). `scoreOil`'s §4.9 note records the same shape on the oil family, and BRENT's docblock is
  // the precedent that a self-recalibrating level arm carries no tunable at all. So a CG override
  // still moves scoring (via the return leg) and `validateMultiplierConfig` is right not to throw —
  // it just cannot reach the level leg, and that is the intended reading.
  "CG", "VT", "EURC", "GB", "DISP", "R7", "FXH", "DB_SMH", "DB_XLK",
  // BUND — `scoreCurve`'s LEVEL leg (b) resolves its ONE (amber) cut through resolveBands; its `red` is read by
  // no leg (`RED_LEG_INERT_IDS`), and its velocity/escalation knobs are NOT multiplier-scaled.
  "BUND",
]);

/** Reachable ids whose resolved RED leg no scorer reads — a per-leg `redMult` on one would be a silent no-op, so
 *  `validateMultiplierConfig` throws on it (a shared `multiplier` still moves the amber leg). */
export const RED_LEG_INERT_IDS: ReadonlySet<string> = new Set(["BUND"]);

/**
 * Fail-loud config guard: every override in `multipliers` that is NOT an inert 1.0/label-only
 * placeholder must (a) name a known indicator id (`knownIds`, injected so this stays a leaf —
 * the caller passes `ALL_INDICATORS` ids) and (b) be in `REACHABLE_IDS`. A non-default
 * override on an unreachable id would silently do nothing in prod, so it throws. Test-enforced
 * (Stage 2.4) rather than module-load, to keep the registry→domain→threshold-config DAG
 * acyclic. 1.0 shared placeholders and label-only rows stay legal (no-op).
 */
export function validateMultiplierConfig(knownIds: ReadonlySet<string>, config: ThresholdConfig = cfg): void {
  for (const [id, entry] of Object.entries(config.multipliers ?? {})) {
    const nonDefaultShared = typeof entry.multiplier === "number" && entry.multiplier !== 1.0;
    const hasPerLeg = Number.isFinite(entry.amberMult) || Number.isFinite(entry.redMult);
    if (!nonDefaultShared && !hasPerLeg) continue; // inert 1.0 / label-only — always legal
    if (!knownIds.has(id)) {
      throw new Error(`threshold-config: "${id}" is not a known ALL_INDICATORS id`);
    }
    if (!REACHABLE_IDS.has(id)) {
      throw new Error(
        `threshold-config: "${id}" carries a non-default multiplier but is not in ` +
          `REACHABLE_IDS, so the override would be a silent no-op in prod. Either its scorer ` +
          `is not wired to consume a multiplier (wire it), or it IS wired and this ` +
          `hand-maintained set is stale (add "${id}" to REACHABLE_IDS in this file). Check the ` +
          `scorer before assuming the first - docs/reference.md §[indicator]`,
      );
    }
    if (Number.isFinite(entry.redMult) && RED_LEG_INERT_IDS.has(id)) {
      throw new Error(`threshold-config: "${id}" carries a redMult but no scorer reads its red leg (RED_LEG_INERT_IDS)`);
    }
  }
}

/**
 * Resolve `id`'s effective (amber, red) bands from its scorer's constant priors. Each leg
 * is scaled by its per-leg `amberMult`/`redMult` when finite, else the shared `multiplier`
 * (positive-only, default 1.0). A `null` constant (no band) stays null. Used by BOTH the
 * scorers (score-time) and the API display path (drawn band line) so the line always
 * tracks the scored band.
 */
export function resolveBands(
  id: string,
  amberConst: number,
  redConst: number,
  firesHighward: boolean,
  config?: ThresholdConfig,
): { amber: number; red: number };
export function resolveBands(
  id: string,
  amberConst: number | null,
  redConst: number | null,
  firesHighward: boolean,
  config?: ThresholdConfig,
): { amber: number | null; red: number | null };
export function resolveBands(
  id: string,
  amberConst: number | null,
  redConst: number | null,
  firesHighward: boolean,
  config: ThresholdConfig = cfg,
): { amber: number | null; red: number | null } {
  const e = config.multipliers?.[id];
  const shared = resolveMultiplier(id, config);
  // Per-leg `amberMult`/`redMult` keep RAW-multiply semantics (the sign-flip escape hatch,
  // F6/F8 once ran -6.0/-0.5, both flattened); an ABSENT per-leg falls back to the SHARED/default multiplier
  // routed through the normalized earliness form under the caller's `firesHighward` (the
  // per-scorer directionality — HIGH-firing bands move down, LOW-firing bands move up).
  const leg = (constVal: number | null, perLeg: number | undefined): number | null =>
    constVal == null ? null : Number.isFinite(perLeg) ? constVal * (perLeg as number) : earlierCut(constVal, firesHighward, shared);
  return {
    amber: leg(amberConst, e?.amberMult),
    red: leg(redConst, e?.redMult),
  };
}
