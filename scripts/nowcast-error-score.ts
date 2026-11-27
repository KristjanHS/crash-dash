/**
 * Pure half of the nowcast-error probe (E5-E6):
 * the walk-forward pairing and the E6 bar. No IO — the probe hands it prints and proxy closes.
 */
import type { Observation } from "../src/domain-types.js";
import { isoDay } from "../src/dates.js";

/** E6 bar, pre-registered 2026-10-03 — the ONE place these values live. */
export const NOWCAST_BAR_MIN_N = 120;
export const NOWCAST_BAR_MAE_RATIO = 0.7;

export interface ArmScore {
  n: number;
  estMae: number;
  carryMae: number;
  /** estMae / carryMae (NaN when both are 0). */
  ratio: number;
  estP95: number;
  carryP95: number;
  pass: boolean;
  /** The E6 clauses that failed, empty on a pass. */
  fails: string[];
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, x) => a + x, 0) / xs.length);

/** Nearest-rank p95 of |x|: the ceil(0.95·n)-th smallest. NaN on an empty sample. */
export function p95Abs(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.map(Math.abs).sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1]!;
}

/** E6 over paired signed errors (index i of both arms = the same print date): pass iff n ≥ MIN_N AND
 *  estMAE ≤ RATIO × carryMAE AND estP95 ≤ carryP95. */
export function scoreArms(estErr: readonly number[], carryErr: readonly number[]): ArmScore {
  if (estErr.length !== carryErr.length) throw new Error(`unpaired arms: ${estErr.length} est vs ${carryErr.length} carry`);
  const n = estErr.length;
  const estMae = mean(estErr.map(Math.abs));
  const carryMae = mean(carryErr.map(Math.abs));
  const estP95 = p95Abs(estErr);
  const carryP95 = p95Abs(carryErr);
  const fails: string[] = [];
  if (!(n >= NOWCAST_BAR_MIN_N)) fails.push(`n<${NOWCAST_BAR_MIN_N}`);
  if (!(estMae <= NOWCAST_BAR_MAE_RATIO * carryMae)) fails.push(`MAE>${NOWCAST_BAR_MAE_RATIO}×carry`);
  if (!(estP95 <= carryP95)) fails.push("p95>carry");
  return { n, estMae, carryMae, ratio: estMae / carryMae, estP95, carryP95, pass: fails.length === 0, fails };
}

export type ErrUnit = "pp" | "pct";

/** Signed error of `value` vs the print: absolute (OAS, pp) or percent of the print (oil spot, a price). */
export const errorOf = (unit: ErrUnit, value: number, print: number): number =>
  unit === "pp" ? value - print : ((value - print) / print) * 100;

/** The live estimator under test: (prints strictly before D, proxy closes up to D) → estimate, or null. */
export type Estimator = (prints: Observation[], closes: Observation[][]) => { date: string; value: number } | null;

export interface WalkForward {
  dates: string[];
  estErr: number[];
  carryErr: number[];
  /** Print dates with an anchor print but no estimate dated exactly D (null, dated earlier), or a non-positive pct print. */
  skipped: number;
}

const DAY_MS = 86_400_000;
const isoMinusDays = (iso: string, days: number): string => isoDay(new Date(Date.parse(iso) - days * DAY_MS));

/**
 * For every print date D ≥ `from`: the estimator sees prints dated ≤ D − `minPrintAgeDays` (1 = strictly before D)
 * and proxy closes dated ≤ D; a pair exists only when it returns an estimate dated D. Carry = the newest print it saw.
 */
export function walkForward(
  prints: readonly Observation[],
  closes: readonly (readonly Observation[])[],
  estimate: Estimator,
  unit: ErrUnit,
  opts: { from?: string; minPrintAgeDays?: number } = {},
): WalkForward {
  const age = opts.minPrintAgeDays ?? 1;
  const out: WalkForward = { dates: [], estErr: [], carryErr: [], skipped: 0 };
  for (const print of prints) {
    const d = print.date;
    if (opts.from !== undefined && d < opts.from) continue;
    const cutoff = isoMinusDays(d, age);
    const seen = prints.filter((p) => p.date <= cutoff);
    const carry = seen.at(-1);
    if (!carry) continue;
    const est = estimate(seen, closes.map((s) => s.filter((c) => c.date <= d)));
    // A non-positive print has no percent error (WTI 2020-04-20) — dropped, as `oilEstDivergence` drops it.
    if (!est || est.date !== d || (unit === "pct" && print.value <= 0)) {
      out.skipped++;
      continue;
    }
    out.dates.push(d);
    out.estErr.push(errorOf(unit, est.value, print.value));
    out.carryErr.push(errorOf(unit, carry.value, print.value));
  }
  return out;
}

/** No-intercept OLS slope of the print's change on the proxy's change, over consecutive prints in [from, to] whose
 *  dates both carry a proxy value — the hold-out fit an arm's beta is pinned from before it is scored (E10). */
export function fitBeta(
  prints: readonly Observation[],
  proxyAt: (date: string) => number | undefined,
  window: { from?: string; to: string },
): { beta: number; n: number } {
  let sxy = 0;
  let sxx = 0;
  let n = 0;
  for (let i = 1; i < prints.length; i++) {
    const a = prints[i - 1]!;
    const b = prints[i]!;
    if (b.date > window.to || (window.from !== undefined && a.date < window.from)) continue;
    const xa = proxyAt(a.date);
    const xb = proxyAt(b.date);
    if (xa === undefined || xb === undefined) continue;
    sxy += (xb - xa) * (b.value - a.value);
    sxx += (xb - xa) ** 2;
    n++;
  }
  return { beta: sxx > 0 ? sxy / sxx : NaN, n };
}
