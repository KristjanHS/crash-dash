// The published term-spread recession probit, as a pure seam so its two coefficients live in ONE
// place and are unit-testable without a DOM
// (`.claude/rules/frontend.md` §Testable slices go in a pure seam module).
//
// P(recession within 12 months) = Φ(α + β · s), s = the 10y−3m term spread in PERCENTAGE POINTS.
// Estrella & Mishkin, estimated on MONTHLY AVERAGES of daily observations — which is why the only
// series fed to this is R8's 21-obs mean, never a daily close.
//
// ⚠ DISPLAY-ONLY. Nothing scores off this line; the probability axis is a ruler for reading R8's
// level, not a leg. Graduating it into a scored leg is a [USER]-owed decision.
export const PROBIT_ALPHA = -0.5333;
export const PROBIT_BETA = -0.6629;

/** Φ(z) — standard normal CDF via the A&S 7.1.26 erf approximation, |error| < 7.5e-8. */
export function normalCdf(z) {
  if (!Number.isFinite(z)) return null;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  // A&S 7.1.26 erf approximation, folded through the Φ(z) = ½(1 + erf(z/√2)) identity.
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** The modelled 12-month recession probability, in PERCENT (0–100), for a term spread in pp. */
export function recessionProbabilityPct(spread) {
  if (spread == null || !Number.isFinite(spread)) return null;
  // `spread` is finite by the guard above, so `normalCdf` cannot return null here.
  return normalCdf(PROBIT_ALPHA + PROBIT_BETA * spread) * 100;
}
