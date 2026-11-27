/** The HY credit set every leg reads (`creditRungs`): a `hyRetrace` gate at every tranche (`asGate`, never a vote) + the box's `credit_confirms`.
 *  Knobs live in each leg's `Rules` under these names (`CreditRules`), one value across legs — retune all three together (parity: probe-spit-tranches.test.ts); `CREDIT_VEL_HIGH_N` is the per-leg opt-in. */
import type { Cell } from "../src/ladder-box.js";
import { ma, retraceLine, retraced } from "../src/ladder-jobs.js";
import { dpCell, fixNum, peakLow, vs, type ReadTag } from "../src/ladder-live.js";
import { INDICATORS } from "../src/registry-fred.js";
import type { Pt } from "./ladder-replay.js";
import { shockOf, shockSince, type ShockKnobs } from "./ladder-shock.js";

export type CreditRules = ShockKnobs & { T1_RETRACE: number; T2_RETRACE: number; T2_PEAK_AGE_N: number; T3_RETRACE: number; ESC_HY_MA_K: number; ESC_SPREAD_MA_N: number; CREDIT_VEL_HIGH_N?: number };
export type CreditInputs = { s: { F1: Pt[] }; exit?: string };
export type CreditReading = { value: string; verdict: "met" | "unmet" | "na" };
export type CreditRung<R extends CreditRules = CreditRules> = { tag: ReadTag; rule: (r: R) => string; read: (r: R, x: CreditInputs) => CreditReading };

const EPS = 1e-9;
const NA: CreditReading = { value: "—", verdict: "na" };
const knob = (x: number): string => String(+x.toPrecision(6));
const FRAC: readonly [number, string][] = [[1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"]];
const frac = (f: number): string => FRAC.find(([v]) => Math.abs(v - f) < EPS)?.[1] ?? knob(f);

const F1 = INDICATORS.find((i) => i.id === "F1");
const [VEL_N, VEL_CUT] = [F1?.velocityWindow, F1?.thresholds.amberVelocity];
if (VEL_N === undefined || VEL_CUT === undefined) throw new Error("ladder-credit: F1 lacks velocityWindow/amberVelocity");
/** HY easing, opt-in `CREDIT_VEL_HIGH_N` (user 2026-11-13): F1's amber velocity leg quiet (Δ(velocityWindow) > amberVelocity false — F1's own `>`, no EPS) AND the last close < its CREDIT_VEL_HIGH_N-close high; null = off, short or not easing. */
export const hyEasing = (c: Pt[], r: Pick<CreditRules, "CREDIT_VEL_HIGH_N">): string | null => {
  const n = r.CREDIT_VEL_HIGH_N;
  if (!n || c.length <= Math.max(VEL_N, n - 1)) return null;
  const last = c.at(-1)!.value!;
  const [d, hi] = [last - c.at(-1 - VEL_N)!.value!, Math.max(...c.slice(-n).map((p) => p.value!))];
  return !(d > VEL_CUT) && last < hi - EPS ? `easing: HY Δ${VEL_N} ${d >= 0 ? "+" : ""}${d.toFixed(2)} ≤ ${VEL_CUT} · ${last.toFixed(2)} < ${n}-close high ${hi.toFixed(2)}` : null;
};

/** HY `f` of the way back from its own latest shock peak to its base, the peak ≥ `age` closes old; quiet (shock closed before the exit) → met;
 *  no open episode, none ever opened, or no HY close on/after the exit (stale feed) → n/a. Another spread reads through `x.s.F1` under its own `label`;
 *  `floor` > 0 arms the rung only once the peak sits ≥ floor over the lower of its base and the exit close — under it, or with no shock ever opened,
 *  the rung reads unarmed, met (Semis BBB, user 2026-11-04). The exit close keeps a re-anchored second wave (a raised base) armed.
 *  `vel` (HY rungs only): an unmet retrace (age included) reads met when `hyEasing` fires. */
export const hyRetrace = <R extends CreditRules = CreditRules>(tag: ReadTag, f: (r: R) => number, age: (r: R) => number, o: { label?: string; floor?: (r: R) => number; vel?: true } = {}): CreditRung<R> => ({
  tag,
  rule: (r) => `${o.label ?? "HY"} ≤ peak − ${frac(f(r))}·(peak − base), base = median of the ${r.BASE_N} closes before its shock${age(r) > 0 ? ` · peak ≥ ${age(r)} closes old` : ""}${o.floor ? ` · armed at peak ≥ min(base, exit close) + ${knob(o.floor(r))}` : ""}${o.vel && r.CREDIT_VEL_HIGH_N ? ` · OR HY Δ${VEL_N} ≤ ${VEL_CUT} and < its ${r.CREDIT_VEL_HIGH_N}-close high` : ""}`,
  read: (r, x) => {
    const c = x.s.F1;
    const label = o.label ?? "HY";
    if (x.exit !== undefined && !c.some((p) => p.date >= x.exit!)) return NA;
    const k = { BASE_N: r.BASE_N, SIGMA_N: r.SIGMA_N, BROKE_SD: r.BROKE_SD };
    const sh = x.exit === undefined ? null : shockOf(c, k);
    if (sh !== null && shockSince(c, k, x.exit!) === null) return { value: `quiet: ${label} shock closed ${sh.closedAt}`, verdict: "met" };
    const floor = o.floor?.(r) ?? 0;
    if (sh === null || !sh.broke) return floor > 0 && x.exit !== undefined ? { value: `unarmed: no ${label} shock`, verdict: "met" } : NA;
    if (floor > 0) {
      const ex = c.findLast((p) => p.date <= x.exit!)?.value ?? sh.base;
      const [from, word] = ex < sh.base ? [ex, "exit"] : [sh.base, "base"];
      if (sh.peak - from < floor - EPS) {
        const [w, fl] = vs(sh.peak - from, floor);
        return { value: `unarmed: ${label} widened ${w} < ${fl} ${peakLow({ value: sh.peak, date: sh.peakDate }, { value: from }, word)}`, verdict: "met" };
      }
    }
    const line = retraceLine(sh, f(r));
    const old = c.filter((p) => p.date > sh.peakDate).length;
    const [v, l] = vs(c.at(-1)!.value, line);
    const value = `${v}/${l} ${peakLow({ value: sh.peak, date: sh.peakDate }, { value: sh.base }, "base")}${age(r) > 0 ? ` · ${old}/${age(r)} closes` : ""}`;
    if (retraced(c, c.length - 1, line, { eps: EPS }) && old >= age(r)) return { value, verdict: "met" };
    const easing = o.vel ? hyEasing(c, r) : null;
    return easing === null ? { value, verdict: "unmet" } : { value: `${value} · ${easing}`, verdict: "met" };
  },
});
/** The credit family's `fam(...)` args: one rung per tranche, T1 ⅓ · T2 ½ + T2_PEAK_AGE_N · T3 ⅔. */
export const CREDIT_FAM = { name: "credit", leg: "credit HY OAS", src: { kind: "dash", id: "F1" } } as const;
export const creditRungs = (tag: ReadTag): readonly [CreditRung, CreditRung, CreditRung] => [
  hyRetrace(tag, (r) => r.T1_RETRACE, () => 0, { vel: true }),
  hyRetrace(tag, (r) => r.T2_RETRACE, (r) => r.T2_PEAK_AGE_N, { vel: true }),
  hyRetrace(tag, (r) => r.T3_RETRACE, () => 0, { vel: true }),
];
/** A credit rung as its tranche's gate row — the roster wraps every tranche's credit rung in it, so credit never enters the vote count. */
export const asGate = <L extends { leg: string }>(g: L): L & { gate: true } => ({ ...g, gate: true, leg: `gate: ${g.leg}` });

/** Box member `credit_confirms`: HY's last close ≥ ESC_HY_MA_K × its MA(ESC_SPREAD_MA_N), read `HY close/cut (MA200 ma)`; `none` with no history, `na` short of the MA; a hit un-votes when `hyEasing` fires. */
export const creditConfirms = (F1: Pt[], r: Pick<CreditRules, "ESC_HY_MA_K" | "ESC_SPREAD_MA_N" | "CREDIT_VEL_HIGH_N">): { cell: Cell; rule: string; value: string } => {
  const rule = `HY ≥ ${knob(r.ESC_HY_MA_K)}× its MA${r.ESC_SPREAD_MA_N}${r.CREDIT_VEL_HIGH_N ? `, unless HY Δ${VEL_N} ≤ ${VEL_CUT} and < its ${r.CREDIT_VEL_HIGH_N}-close high` : ""}`;
  if (!F1.length) return { cell: "none", rule, value: "HY no history" };
  if (F1.length < r.ESC_SPREAD_MA_N) return { cell: "na", rule, value: `HY short of ${r.ESC_SPREAD_MA_N} closes` };
  const [v, m] = [F1.at(-1)!.value!, ma(F1, r.ESC_SPREAD_MA_N)!];
  const [cut, d] = [r.ESC_HY_MA_K * m, dpCell([[v, r.ESC_HY_MA_K * m]])];
  const value = `HY ${fixNum(v, d)}/${fixNum(cut, d)} (MA${r.ESC_SPREAD_MA_N} ${fixNum(m, d)})`;
  if (v < cut - EPS) return { cell: false, rule, value };
  const easing = hyEasing(F1, r);
  return easing === null ? { cell: "hit", rule, value } : { cell: false, rule, value: `${value} · ${easing}` };
};
