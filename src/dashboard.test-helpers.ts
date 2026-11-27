import { INDICATORS } from "./registry-fred.js";
import { type Indicator, type Observation } from "./domain-types.js";

// --- scoreIndicator helpers: synthetic series long enough to confirm a state.
export const N = 30; // > VELOCITY_WINDOW (20) + CONFIRM_CLOSES (2)
export const flatN = (value: number, n: number): Observation[] =>
  Array.from({ length: n }, (_, i) => ({ date: `d${i}`, value }));
export const flat = (value: number): Observation[] => flatN(value, N);
export const ramp = (step: number): Observation[] =>
  Array.from({ length: N }, (_, i) => ({ date: `d${i}`, value: i * step }));

export const indicator = (over: Partial<Indicator>): Indicator => ({
  id: "X",
  label: "x",
  longLabel: "x",
  series: "X",
  channel: "RATE",
  thresholds: {},
  ...over,
});

export const byId = (id: string): Indicator => INDICATORS.find((ind) => ind.id === id)!;

// UTC day-index → ISO date (oldest→newest); month/day default to Jan 1.
export const utcDay =
  (year: number, month = 0, day = 1) =>
  (i: number): string =>
    new Date(Date.UTC(year, month, day) + i * 86_400_000).toISOString().slice(0, 10);
// 2026-MM day-of-month formatter (i is 0-based ⇒ day i+1).
export const monthDay =
  (mm: string) =>
  (i: number): string =>
    `2026-${mm}-${String(i + 1).padStart(2, "0")}`;

// getLastAlert (newest-by-firedAt) is covered against InMemoryStore by the shared
// storeContract in store.contract.test.ts — no separate dashboard-level case needed.

// --- price indicators (Phase 4 Stage 2) -----------------------------------
// Synthetic daily closes, oldest -> newest. PN > MA_WINDOW(200)+CONFIRM and
// > HIGH_WINDOW(252)+CONFIRM so both scorers have enough history. Zero-padded
// dates keep cross-series alignment (alignByDate is an exact date inner-join).
export const PN = 260;
export const priceSeries = (fn: (i: number) => number): Observation[] =>
  Array.from({ length: PN }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, value: fn(i) }));

// F4 is CONTEXT (Phase-2 C5): surfaced, not scored. scoreSemis is channel-
// agnostic (it only sets reading.indicator), so these state assertions are
// unaffected by the channel — the fixture just reflects F4's real channel now.
export const f4 = indicator({ id: "F4", channel: "CONTEXT", thresholds: {} });
export const f5 = indicator({ id: "F5", channel: "CONTEXT", thresholds: {} });
export const spconc = indicator({ id: "SPCONC", channel: "CONTEXT", thresholds: {} });

// Breadth-band fixtures: length ≥ HIGH_WINDOW + BREADTH_CUT_WINDOW + CONFIRM_CLOSES (the scoreBreadth
// rankable floor), else the "need N aligned closes" guard throws before a state forms.
export const BN = 520;
// A STRICTLY-INCREASING QQQ ratio (QQQE flat at 1). Because it only ever makes new highs, the
// strict-prior high is always the previous close, so `dist[i]` reduces to the day's return `g[i]` —
// giving the test exact control over where each day lands in the dist distribution. The body cycles
// a positive spread; the LAST day carries `tailReturn` (its dist), so a caller places the tail in a
// chosen percentile band. Still at-a-new-high AND rising every day (the OLD atHigh∧rising regime).
export const breadthClimb = (
  tailReturn: number,
  n: number = BN,
): { qqq: Observation[]; qqqe: Observation[] } => {
  const qqq: Observation[] = [];
  const qqqe: Observation[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    const g = i === n - 1 ? tailReturn : 0.002 + 0.0006 * (i % 40);
    v *= 1 + g;
    const date = `d${String(i).padStart(4, "0")}`;
    qqq.push({ date, value: v });
    qqqe.push({ date, value: 1 });
  }
  return { qqq, qqqe };
};
