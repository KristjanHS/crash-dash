/**
 * Semis (SEC0) re-entry ladder — four voting families + a credit gate (`ladder-credit.ts`) × three tranches over prod `/api/series` plus the `signs[]` rows of `public/semis.json`;
 * read-only report, `--into=` writes `verdict` only (+ re-renders `docs/semis.md` on the canonical path, `ladder-into.ts`). Cuts = `SEMIS_RULES`; shape = the Value probe's family ladder.
 * Reads stored `LEGP_SEMIS` price rows, which exist only once a daily-closes source is bound and `retainable()` keeps them
 * (README §Data sources and extension points); with none its price rungs read unread (`–`) and no SEC0 drawdown opens.
 */
import { META } from "../src/api/http.js";
import { heldSigns, reachOf, reviewedSigns } from "../src/ladder-block.js";
import { BOX_KERNEL, boxOf, kleeneAnd, type Cell, type Roster } from "../src/ladder-box.js";
import { allEvents, dpCell, familyRow, fixNum, LEGS as LADDER_LEGS, probeTrancheCell, toVerdict, vcAt, vs, watchGrade, type LadderEventDone, type LadderFamily, type LadderLive, type LadderProbeResult, type LadderSign, type LadderVerdict, type ReadTag, type TaggedRead, type TrancheId } from "../src/ladder-live.js";
import { delta, ma, maPair, newExtreme, noLowRun, offHigh, quietRun, SEMIS_MOVE_MEDIAN, SEMIS_VOL_MEDIAN, speedZ } from "../src/ladder-jobs.js";
import { allFizzled } from "../src/ladder-run.js";
import { replayScorecard, type ReplaySpec } from "./ladder-replay-feeds.js";
import { BINDING, episodes, scoreEpisode, REPLAY, episodeWindow, fetchEach, knob, last, pct, upTo, vals, type EpisodeResult, type ReplayKnobs, type WhyRow } from "./ladder-replay.js";
import { asOfOf, closes, estTagged, livePrints, fetchPoints, type Pt } from "./probe-eufin-tranches.js";
import { asGate, CREDIT_FAM, creditConfirms, creditRungs, hyRetrace } from "./ladder-credit.js";
import { guardAnchor, hybridBreak, median } from "./ladder-shock.js";
import { boxHolds, boxStatus, clearedBox, famNeedOf, fizzleFill, followedOf, intoLive, legsOf, votesText, walkFollow, provisionalOn, readIdsOf, tallyOf, tranchesOf, cellsOf, famRows, isRead, sinceOf, tick, type NeedKnobs, type RawLeg, type Reading, type TrancheResult, type Verdict } from "./ladder-tranche.js";
import { isoDay } from "../src/dates.js";
import { EPS, eachId, INDICATOR, kMa, SERIES, tagOf, type Id, type SeriesSet } from "./semis-series.js";
import { openEpisode, watchLatched } from "./semis-watch.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";
export { boxHolds, intoLive } from "./ladder-tranche.js";
export type { Pt };

const unserved = SERIES.filter((id) => !META.has(id));
if (unserved.length) throw new Error(`probe:semis-tranches — not served by /api/series: ${unserved.join(", ")}`);

/** The `signs[].sign` ids the probe knows; a `block` on any other id throws, and only a `VETO_ROWS` block holds a tranche (`boxOf`, its reach `VETO_MEASURED`). */
export const SIGNS = ["real_yield", "dram_contract", "mu_dio", "mu_gm", "korea_exports", "hbm", "china_memory", "sia_3mma", "wwsems", "tsmc_monthly", "capex_guides", "ai_funding", "lab_revenue", "mu_strike", "taiwan_export", "vxsmh", "sox_breadth", "yen_carry", "cftc_yen", "curve_10y3m", "cg_drop", "pc_demand"] as const;
export type SignId = (typeof SIGNS)[number];
/** The ladder's families, one rung per tranche each (`FAMS`). */
export const FAMILIES = ["price", "memory", "capex", "rates", "credit"] as const;
/** The families a tranche counts (`famNeed`'s N); credit only gates. */
export const VOTE_FAMILIES = FAMILIES.filter((f) => f !== "credit");
/** The Episode gates display rows (`escalation().families`) — a row duplicating a `CLUSTERS` member is that member, never a family. */
export const BOX_SIGNS = ["memory_turn", "taiwan_export", "vxsmh", "curve_10y3m", "cg_drop", "yen_carry"] as const;
export type BoxSign = (typeof BOX_SIGNS)[number];
/** Each box row's sign rows: a family's read `block` trips it; a member carries them (`signs`) and its cell stays its ruled read; `[]` = measured only. */
export const BOX_ROWS: Record<BoxSign | Member, readonly SignId[]> = { real_yield: ["real_yield"], capex_clock: ["capex_guides"], credit_confirms: [], memory_turn: ["dram_contract"], vol_flip: [], taiwan_export: ["taiwan_export"], move: [], vxsmh: [], curve_10y3m: [], cg_drop: [], yen_carry: [] };
/** Display-only links (`boardFamilies`): the row lists these, but its trip and verdict stay close-only — a `block` here holds nothing. */
const BOX_SHOWN: Partial<Record<BoxSign | Member, readonly SignId[]>> = { vxsmh: ["vxsmh"], curve_10y3m: ["curve_10y3m"], cg_drop: ["cg_drop"], yen_carry: ["yen_carry"] };
/** The series each box sign's close read touches — the live cell's `est.` tag reads their heads; pinned against `escalation`'s own reads in the probe test. */
export const BOX_IDS: Record<BoxSign, readonly Id[]> = { memory_turn: ["F8"], taiwan_export: [], vxsmh: ["VXSMH"], curve_10y3m: ["T10Y3M_RAW"], cg_drop: ["CG"], yen_carry: ["F17"] };

/** `memory_turn`'s MU-off-high cut; the watch `mu` correction (`W_MU_CORR`) is its negation. */
const MU_OFF = 0.2;
/** Every cut lives here only. HCX is a fraction off its 12-mo high; F1/R4 are % levels; VT a ratio. */
export const SEMIS_RULES = {
  FAM_T2_SHARE: 0.4,
  FAM_T3_SHARE: 0.6,
  MA_FAST_N: 50,
  MA_SLOW_N: 200,
  /** Price rungs need close > K × MA (user 2026-10-17: replaced T1/T2's closes-since-low counts). */
  MA_FAST_K: 0.96,
  MA_SLOW_K: 1,
  /** [default] for the MA200 slope: MA now vs MA this many closes back. */
  MA_RISING_N: 10,
  /** T3 price: MA_FAST_N over MA_SLOW_N on this many straight closes (replaced 120 closes since low, user 2026-10-12). */
  T3_CROSS_N: 10,
  /** T2 price: no post-exit SEC0 low (`noLowRun`, a tie is no new low) for LOW_HOLD_N closes (user 2026-10-18). */
  LOW_HOLD_N: 10,
  /** T1 `priceHold` gate's no-low run (user 2026-10-20). */
  T1_LOW_HOLD_N: 3,
  /** T1 memory: MU_RS Δ over this many closes > 0 (user 2026-10-20). */
  T1_MU_DELTA_N: 10,
  HCX_DELTA_N: 10,
  HCX_T2_MIN: -0.05,
  /** User 2026-10-12: T2's capex vote also needs HCX rising over this many closes. */
  HCX_T2_DELTA_N: 20,
  HCX_T3_N: 20,
  HCX_GATE_MIN: -0.1,
  R4_DELTA_N: 20,
  R4_Z_WINDOW: 250,
  R4_Z_MAX: 1,
  R4_D_MAX: 0.1,
  T3_R4_D_MAX: 0,
  R4_HIGH_N: 60,
  T2_R4_N: 5,
  T3_R4_N: 10,
  /** credit T1–T3 (`hyRetrace`, `ladder-credit.ts`): HY's own latest shock (`shockOf`, shared with Value/Spit): base = median of the BASE_N closes before its anchor; σ = sd of the SIGMA_N daily Δ before it; a period opens on a fresh BROKE_SD σ rise. None ever opened → n/a; closed before the exit (`shockSince`) → quiet, met. */
  BASE_N: 20,
  SIGMA_N: 60,
  BROKE_SD: 3,
  /** Credit is a gate at every tranche, never a vote (user 2026-10-20): HY back this share of peak → base; T2 also needs the peak T2_PEAK_AGE_N closes old. */
  T1_RETRACE: 1 / 3,
  T2_RETRACE: 1 / 2,
  T2_PEAK_AGE_N: 10,
  T3_RETRACE: 2 / 3,
  /** HY easing OR on T1–T3 + `credit_confirms` (`hyEasing`, user 2026-11-13): the N-close high HY must sit under. */
  CREDIT_VEL_HIGH_N: 10,
  /** T2·T3 BBB OAS gate (`bbbGate`, user 2026-11-04): the HY rung's T2/T3 retrace + age over BBB's own shock, armed only once peak − base ≥ this (absolute pts) — 3 y of BBB: only 2025-04 (0.48) arms. */
  BBB_MIN_WIDEN: 0.23,
  ESC_HCX: -0.1,
  /** `credit_confirms`: HY over ESC_HY_MA_K × its MA(ESC_SPREAD_MA_N) — Siegel's MA-ratio rule on spreads, user 2026-10-13; HY only since CCC left Semis (user 2026-10-20). */
  ESC_SPREAD_MA_N: 200,
  ESC_MU_OFF: MU_OFF,
  /** [default] the MU high `memory_turn` reads off, in closes. */
  MU_HIGH_N: 250,
  ESC_VT: 1.05,
  /** `move` / `vxsmh`: close > ESC_MOVE_MED_K / ESC_VOL_MED_K × the median of the last ESC_VOL_MED_N closes; `curve_10y3m`: raw daily T10Y3M (never R1's 21-close mean) < ESC_CURVE; `cg_drop`: CG Δ over ESC_CG_N closes ≤ −ESC_CG_DROP (user 2026-10-18). */
  ESC_VOL_MED_N: SEMIS_VOL_MEDIAN.window,
  ESC_VOL_MED_K: SEMIS_VOL_MEDIAN.mult,
  ESC_MOVE_MED_K: SEMIS_MOVE_MEDIAN.mult,
  ESC_CURVE: 0,
  ESC_CG_N: 20,
  ESC_CG_DROP: 0.1,
  /** Ruled box member cuts (`ruledCells`): VT ≥ ESC_VT ×ESC_VOL_FLIP_N · DFII10 Δ(ESC_REAL_DELTA_N) ≥ ESC_REAL_DELTA ·
   *  HY ≥ ESC_HY_MA_K × MA(ESC_SPREAD_MA_N). */
  ESC_VOL_FLIP_N: 10,
  ESC_REAL_DELTA_N: 120,
  ESC_REAL_DELTA: 0.75,
  ESC_HY_MA_K: 1.1,
  /** `yen_carry` display row (`yenD10`): worst USD/JPY d(YEN_N) over the last YEN_N closes ≤ −YEN_DROP. */
  YEN_N: 10,
  YEN_DROP: 0.03,
  /** memory T2/T3 hysteresis (WisdomTree adaptive-MA form): MU_RS flips only after MU_RS_CONFIRM_N straight closes beyond MA·(1 ± MU_RS_BAND). */
  MU_RS_BAND: 0.01,
  MU_RS_CONFIRM_N: 2,
  /** rates absorbed: a new R4_HIGH_N-close DFII10 high inside the last ABSORB_N SEC0 closes while SEC0 rose over them turns an unmet rates rung n/a (user 2026-10-12). */
  ABSORB_N: 20,
  /** catch-up: a SEC0 close above every one of the prior CATCHUP_HIGH_N fires every tranche whose gates are clear. */
  CATCHUP_HIGH_N: 250,
  /** Hybrid guards: the R4 no-high rungs and `absorbed`'s new-high test break on `hybridBreak` while R4's own shock is open; false = rolling only. */
  HYBRID_GUARDS: false,
  /** Watch-row knobs; the roster is `SEMIS_WATCH` (`scripts/semis-watch.ts`). */
  W_TREND_N: 3,
  W_MA200_LAG_N: 20,
  W_EPDD_CORR: -0.08,
  W_EPDD_BEAR: -0.2,
  W_EPDD_HIGH_N: 250,
  W_R10_N: 10,
  W_R10_CORR: -0.08,
  W_R10_BEAR: -0.15,
  /** `watchLatched`: HIGH holds while epdd ≤ W_LATCH_DD (Stage 3.3). */
  W_LATCH_DD: -0.15,
  /** `watchLatched` stretch step: the epdd anchor high close ≥ W_STRETCH_K × its MA`MA_SLOW_N` ∧ epdd ≤ W_STRETCH_DD (Stage 4.2). */
  W_STRETCH_K: 1.25,
  W_STRETCH_DD: -0.12,
  /** Once stepped, the step holds while epdd ≤ W_STRETCH_HOLD (shallower than W_STRETCH_DD: hysteresis, Stage 9.2); re-entry needs W_STRETCH_DD again. */
  W_STRETCH_HOLD: -0.1,
  /** Confirmer rows (`watchLatched` lift): HY OAS Δ`W_HY_N` ≥ `W_HY_D10` (absolute pts) · VXSMH Δ`W_VXSMH_N` ≥ `W_VXSMH_D10` (relative). */
  W_HY_N: 10,
  W_HY_D10: 0.4,
  /** BBB OAS confirmer (Stage 6.3): Δ`W_BBB_N` ≥ `W_BBB_D10` ∨ ≥ the `W_BBB_LOW_N`-close low + `W_BBB_RISE` (absolute pts). */
  W_BBB_N: 10,
  W_BBB_D10: 0.2,
  W_BBB_LOW_N: 126,
  W_BBB_RISE: 0.3,
  /** HCX change rules on its 12-mo-high distance (`/api/series?id=HCX` serves no level): correction Δ`W_HCX_N` ≤ `W_HCX_D20`, bear Δ`W_HCX_BEAR_N` ≤ `W_HCX_D63`. */
  W_HCX_N: 20,
  W_HCX_D20: -0.075,
  W_HCX_BEAR_N: 63,
  W_HCX_D63: -0.1,
  W_MU_CORR: -MU_OFF,
  W_MU_BEAR: -0.3,
  W_VXSMH_N: 10,
  W_VXSMH_D10: 0.3,
  /** Real-yield + relative-strength rows (Stage 6.1): R4 (DFII10) Δ`W_RY_N` ≥ `W_RY_D20` / `W_RY_BEAR` (absolute pts) · RS_SMH Δ`W_RS_N` ≤ `W_RS_D20` / `W_RS_BEAR` (relative). */
  W_RY_N: 20,
  W_RY_D20: 0.25,
  W_RY_BEAR: 0.5,
  W_RS_N: 20,
  W_RS_D20: -0.08,
  W_RS_BEAR: -0.12,
  W_EVENT_DAYS: 14,
  /** `carriers` context row (R4): ≥ W_CARRIER_N events landed `escalation:` ≤ W_EVENT_DAYS. */
  W_CARRIER_N: 2,
  W_EVENT_BEAR_DAYS: 21,
  W_EVENT_BEAR_N: 2,
} as const;
export type Rules = { [K in keyof typeof SEMIS_RULES]: (typeof SEMIS_RULES)[K] extends boolean ? boolean : number };

export type Tranche = TrancheId;
export type { Verdict };
/** `exit`/`start` = the open episode's exit and shock start (`openEpisode`). */
export type Inputs = { s: SeriesSet; signs: readonly LadderSign[]; exit?: string; start?: string };
/** `foot` = a clause shared across rows (`VerdictLeg.foot`), a numbered footnote on the expected cell. */
export type LegDef = { key: string; tranche: Tranche; gate?: boolean; leg: string; src: { kind: "dash"; id: Id }; tag: ReadTag; rule: (r: Rules) => string; foot?: (r: Rules) => string; read: (r: Rules, x: Inputs) => Reading };
export type LegResult = Reading & { key: string; tranche: Tranche; leg: string; rule: string; foot?: string; gate: boolean; live: Reading; tag: ReadTag };

const NA: Reading = { value: "—", verdict: "na" };
const fix = fixNum;
/** MA(n) now and `lag` closes back. */
/** Above-MA(n) state with hysteresis: set after `confirm` straight closes > MA·(1+band), cleared after `confirm` straight < MA·(1−band), held in between; null under n closes. */
const bandedAbove = (c: Pt[], n: number, band: number, confirm: number): boolean | null => {
  if (c.length < n) return null;
  let [sum, up, dn, above] = [0, 0, 0, false];
  for (let i = 0; i < c.length; i++) {
    sum += c[i]!.value! - (i >= n ? c[i - n]!.value! : 0);
    if (i < n - 1) continue;
    const [v, m] = [c[i]!.value!, sum / n];
    [up, dn] = [v > m * (1 + band) ? up + 1 : 0, v < m * (1 - band) ? dn + 1 : 0];
    if (up >= confirm) above = true;
    else if (dn >= confirm) above = false;
  }
  return above;
};
/** Sub-tests ANDed: each printed with its ✓/✗. */
const allOf = (bits: readonly (readonly [string, boolean])[], count?: Reading["count"]): Reading => ({ value: bits.map(([t, ok]) => `${t}${ok ? "✓" : "✗"}`).join(" · "), verdict: tick(bits.every(([, ok]) => ok)), ...(count && { count }) });

type Rung = Pick<LegDef, "rule" | "read" | "tag" | "foot"> & { src?: LegDef["src"]; leg?: string };
type Rungs = readonly [Rung, Rung, Rung] | readonly [Rung, Rung];
export type Fam<N extends Rungs = Rungs> = { name: (typeof FAMILIES)[number]; rungs: { readonly [K in keyof N]: LegDef } };
/** One family = one rung per tranche, keyed `t<k>-<name>`; a two-rung family casts no T3 vote. */
const fam = <N extends Rungs>(name: Fam["name"], leg: string, src: LegDef["src"], rungs: N): Fam<N> => ({
  name,
  rungs: famRows(name, leg, src, rungs) as unknown as Fam<N>["rungs"],
});

const priceRung = (k: 0 | 1 | 2, tag: ReadTag): Rung => ({
  tag,
  rule: (r) => [k < 2 && `> ${kMa(r.MA_FAST_K, r.MA_FAST_N)}, MA${r.MA_FAST_N} Δ${r.MA_RISING_N} > 0`, k > 0 && `> ${kMa(r.MA_SLOW_K, r.MA_SLOW_N)}, MA${r.MA_SLOW_N} Δ${r.MA_RISING_N} > 0`, k === 2 && `MA${r.MA_FAST_N} > MA${r.MA_SLOW_N} ×${r.T3_CROSS_N}`, k === 1 && `no new low since the drawdown opened ×${r.LOW_HOLD_N}`].filter(Boolean).join(" · "),
  read: (r, x) => {
    const c = x.s.LEGP_SEMIS;
    const [f, fb] = maPair(c, r.MA_FAST_N, r.MA_RISING_N);
    const [s, sb] = maPair(c, r.MA_SLOW_N, r.MA_RISING_N);
    if (x.exit === undefined || (k < 2 && (f === null || fb === null)) || (k > 0 && (s === null || sb === null))) return NA;
    const nl = k === 1 ? noLowRun(c, x.exit, r.LOW_HOLD_N) : null;
    if (k === 1 && nl === null) return NA;
    const px = last(c)!.value!;
    const [fk, sk] = [f === null ? null : r.MA_FAST_K * f, s === null ? null : r.MA_SLOW_K * s];
    const got = k === 2 ? quietRun(c, r.T3_CROSS_N, (i) => ((h) => ma(h, r.MA_FAST_N)! > (ma(h, r.MA_SLOW_N) ?? Infinity))(c.slice(0, i + 1))) : 0;
    // One width for the close and both scaled MAs across the cell's bits.
    const w = dpCell([...(k < 2 ? [[px, fk] as const] : []), ...(k > 0 ? [[px, sk] as const] : []), ...(k === 2 ? [[f, s] as const] : []), ...(nl ? [[px, nl.low?.value] as const] : [])]);
    const bits: [string, boolean][] = [
      ...(k < 2 ? ([[((a, b) => `${a}>${kMa(r.MA_FAST_K, r.MA_FAST_N)} ${b}`)(...vs(px, fk, w)), px > fk!], [`MA${r.MA_FAST_N} Δ${r.MA_RISING_N} ${fix(f! - fb!, 3)}>0`, f! > fb!]] as [string, boolean][]) : []),
      ...(k > 0 ? ([[((a, b) => `${k === 2 ? a : ""}>${kMa(r.MA_SLOW_K, r.MA_SLOW_N)} ${b}`)(...vs(px, sk, w)), px > sk!], [`MA${r.MA_SLOW_N} Δ${r.MA_RISING_N} ${fix(s! - sb!, 3)}>0`, s! > sb!]] as [string, boolean][]) : []),
      ...(k === 2 ? ([[((a, b) => `MA${r.MA_FAST_N} ${a}>MA${r.MA_SLOW_N} ${b}`)(...vs(f, s, w)), got >= r.T3_CROSS_N]] as [string, boolean][]) : []),
      ...(nl ? ([[`no low ${vcAt(px, nl.low, w)}`, nl.got >= r.LOW_HOLD_N]] as [string, boolean][]) : []),
    ];
    return allOf(bits, k === 2 ? { got, need: r.T3_CROSS_N } : nl ? { got: nl.got, need: r.LOW_HOLD_N } : undefined);
  },
});
const PRICE = fam("price", "price SEC0 €", { kind: "dash", id: "LEGP_SEMIS" }, [
  priceRung(0, tagOf({ series: ["LEGP_SEMIS"], job: "regime", agg: "kOfN" })),
  priceRung(1, tagOf({ series: ["LEGP_SEMIS"], job: "composite", agg: "kOfN" })),
  priceRung(2, tagOf({ series: ["LEGP_SEMIS"], job: "regime", agg: "kOfN" })),
]);

/** MU/SMH above its MA(n) under the `bandedAbove` hysteresis, optionally with that MA rising. */
const muRsRung = (slow: boolean, tag: ReadTag): Rung => ({
  tag,
  src: { kind: "dash", id: "MU_RS" },
  leg: "memory MU/SMH",
  rule: (r) => `MU_RS > MA${slow ? r.MA_SLOW_N : r.MA_FAST_N} (±${knob(r.MU_RS_BAND * 100)}% ×${r.MU_RS_CONFIRM_N})${slow ? "" : `, MA${r.MA_FAST_N} Δ${r.MA_RISING_N} > 0`}`,
  read: (r, x) => {
    const c = x.s.MU_RS;
    const n = slow ? r.MA_SLOW_N : r.MA_FAST_N;
    const [m, mb] = maPair(c, n, r.MA_RISING_N);
    const above = bandedAbove(c, n, r.MU_RS_BAND, r.MU_RS_CONFIRM_N);
    if (m === null || above === null || (!slow && mb === null)) return NA;
    return allOf([[((a, b) => `${a}>MA${n} ${b}`)(...vs(last(c)!.value, m, 4)), above], ...(slow ? [] : ([[`MA${r.MA_FAST_N} Δ${r.MA_RISING_N} ${fix(m - mb!, 4)}>0`, m > mb!]] as [string, boolean][]))]);
  },
});
const MEMORY = fam("memory", "memory MU/SMH", { kind: "dash", id: "MU_RS" }, [
  {
    tag: tagOf({ series: ["MU_RS"], job: "speed", agg: "kOfN", variant: "absΔ10" }),
    rule: (r) => `MU_RS Δ${r.T1_MU_DELTA_N} > 0`,
    read: (r, x) => ((d) => (d === null ? NA : { value: `Δ${r.T1_MU_DELTA_N} ${fix(d, 4)}>0`, verdict: tick(d > 0) }))(delta(x.s.MU_RS, r.T1_MU_DELTA_N)),
  },
  muRsRung(false, tagOf({ series: ["MU_RS"], job: "regime", agg: "kOfN" })),
  muRsRung(true, tagOf({ series: ["MU_RS"], job: "regime", agg: "kOfN" })),
]);

const CAPEX = fam("capex", "capex HCX 12-mo-high dist", { kind: "dash", id: "HCX" }, [
  {
    tag: tagOf({ series: ["HCX"], job: "speed", agg: "kOfN", variant: "absΔ10" }),
    rule: (r) => `HCX Δ${r.HCX_DELTA_N} > 0`,
    read: (r, x) => ((d) => (d === null ? NA : { value: `Δ${r.HCX_DELTA_N} ${pct(d)}>0`, verdict: tick(d > 0) }))(delta(x.s.HCX, r.HCX_DELTA_N)),
  },
  {
    tag: tagOf({ series: ["HCX"], job: "composite", agg: "kOfN" }),
    rule: (r) => `HCX ≥ ${pct(r.HCX_T2_MIN)} · Δ${r.HCX_T2_DELTA_N} > 0`,
    read: (r, x) => ((p, d) => (p && d !== null ? allOf([[`${pct(p.value!)}/${pct(r.HCX_T2_MIN)}`, p.value! >= r.HCX_T2_MIN - EPS], [`Δ${r.HCX_T2_DELTA_N} ${pct(d)}>0`, d > 0]]) : NA))(last(x.s.HCX), delta(x.s.HCX, r.HCX_T2_DELTA_N)),
  },
  {
    tag: tagOf({ series: ["HCX"], job: "level", agg: "kOfN" }),
    rule: (r) => `HCX ≥ ${pct(r.HCX_T2_MIN)} ×${r.HCX_T3_N}`,
    read: (r, x) => {
      const c = x.s.HCX;
      if (c.length < r.HCX_T3_N) return NA;
      const got = quietRun(c, r.HCX_T3_N, (i) => c[i]!.value! >= r.HCX_T2_MIN - EPS);
      return { value: `${pct(last(c)!.value!)}/${pct(r.HCX_T2_MIN)}`, verdict: tick(got >= r.HCX_T3_N), count: { got, need: r.HCX_T3_N } };
    },
  },
]);

/** R4 (DFII10) d(R4_DELTA_N) now; null short of history. */
const r4d = (c: Pt[], r: Rules): number | null => delta(c, r.R4_DELTA_N);
/** No new R4_HIGH_N-close high in the last `n` closes, and Δ20 ≤ `dMax`. */
const r4Quiet = (n: (r: Rules) => number, dMax: (r: Rules) => number, tag: ReadTag): Rung => ({
  tag,
  rule: (r) => `no ${r.R4_HIGH_N}-close high ×${n(r)} · Δ${r.R4_DELTA_N} ≤ ${knob(dMax(r))}`,
  read: (r, x) => {
    const c = x.s.R4;
    const d = r4d(c, r);
    if (d === null || c.length < r.R4_HIGH_N + n(r)) return NA;
    const at = guardAnchor(c, r.HYBRID_GUARDS, r);
    const got = quietRun(c, n(r), (i) => !(hybridBreak(c, i, "high", at) ?? newExtreme(c, i, r.R4_HIGH_N, "high", { guard: false })));
    return allOf([["no high", got >= n(r)], [`Δ${r.R4_DELTA_N} ${vs(d, dMax(r))[0]}≤${knob(dMax(r))}`, d <= dMax(r) + EPS]], { got, need: n(r) });
  },
});
/** Rates the market shrugged off: a new R4_HIGH_N-close DFII10 high after the SEC0 close ABSORB_N back, with SEC0 up since; null short of either. */
export const absorbed = (r: Rules, x: Inputs): boolean | null => {
  const [c, y] = [x.s.LEGP_SEMIS, x.s.R4];
  if (c.length <= r.ABSORB_N || y.length <= r.R4_HIGH_N) return null;
  const from = c.at(-1 - r.ABSORB_N)!.date;
  if (!(delta(c, r.ABSORB_N)! > 0)) return false;
  const at = guardAnchor(y, r.HYBRID_GUARDS, r);
  for (let i = y.length - 1; i >= r.R4_HIGH_N && y[i]!.date > from; i--) if (hybridBreak(y, i, "high", at) ?? newExtreme(y, i, r.R4_HIGH_N, "high", { guard: false })) return true;
  return false;
};
/** A rates rung an `absorbed` market takes out of the count (n/a) instead of failing — never met. */
const orAbsorbed = (g: Rung): Rung => ({
  tag: g.tag,
  rule: g.rule,
  foot: (r) => `absorbed (n/a) if both: 10y hit a ${r.R4_HIGH_N}-close high in the last ${r.ABSORB_N} closes · SEC0 is up over those ${r.ABSORB_N} closes`,
  read: (r, x) => ((own) => (own.verdict === "unmet" && absorbed(r, x) ? { ...own, value: `${own.value} · absorbed n/a`, verdict: "na", absorbed: true } : own))(g.read(r, x)),
});
const RATES = fam("rates", "rates 10y RY", { kind: "dash", id: "R4" }, [
  orAbsorbed({
    tag: tagOf({ series: ["R4", "LEGP_SEMIS"], indicator: INDICATOR.R4, job: "speed", agg: "kOfN" }),
    rule: (r) => `Δ${r.R4_DELTA_N} ≤ ${knob(r.R4_D_MAX)} · z(Δ${r.R4_DELTA_N}, ${r.R4_Z_WINDOW}) < ${r.R4_Z_MAX}`,
    read: (r, x) => {
      const c = x.s.R4;
      const d = r4d(c, r);
      const z = speedZ(c, c.length - 1, { n: r.R4_DELTA_N, window: r.R4_Z_WINDOW });
      if (d === null || z === null) return NA;
      return allOf([[`Δ${r.R4_DELTA_N} ${vs(d, r.R4_D_MAX)[0]}≤${knob(r.R4_D_MAX)}`, d <= r.R4_D_MAX + EPS], [`z ${vs(z, r.R4_Z_MAX)[0]}<${r.R4_Z_MAX}`, z < r.R4_Z_MAX]]);
    },
  }),
  orAbsorbed(r4Quiet((r) => r.T2_R4_N, (r) => r.R4_D_MAX, tagOf({ series: ["R4", "LEGP_SEMIS"], indicator: INDICATOR.R4, job: "composite", agg: "kOfN" }))),
  orAbsorbed(r4Quiet((r) => r.T3_R4_N, (r) => r.T3_R4_D_MAX, tagOf({ series: ["R4", "LEGP_SEMIS"], indicator: INDICATOR.R4, job: "composite", agg: "kOfN" }))),
]);

const CREDIT = fam(CREDIT_FAM.name, CREDIT_FAM.leg, CREDIT_FAM.src, creditRungs(tagOf({ series: ["F1"], job: "recovery", agg: "allOf" })));
export const FAMS = { PRICE, MEMORY, CAPEX, RATES, CREDIT } as const;

const capexRollover = (tranche: Tranche, tag: ReadTag): LegDef => ({
  tag,
  key: `${tranche.toLowerCase()}-capex-rollover`,
  tranche,
  gate: true,
  leg: "gate: HCX no rollover",
  src: { kind: "dash", id: "HCX" },
  rule: (r) => `HCX ≥ ${pct(r.HCX_GATE_MIN)}`,
  read: (r, x) => ((p) => (p ? { value: `${pct(p.value!)}/${pct(r.HCX_GATE_MIN)}`, verdict: tick(p.value! >= r.HCX_GATE_MIN - EPS) } : NA))(last(x.s.HCX)),
});
/** T1 only: post-exit price evidence — `noLowRun` ≥ T1_LOW_HOLD_N, or the newest close above the exit close; n/a with no exit. */
const priceHold = (tag: ReadTag): LegDef => ({
  tag,
  key: "t1-price-hold",
  tranche: "T1",
  gate: true,
  leg: "gate: SEC0 drawdown hold",
  src: { kind: "dash", id: "LEGP_SEMIS" },
  rule: (r) => `no new low since the drawdown opened ×${r.T1_LOW_HOLD_N} or close > the close that opened it`,
  read: (r, x) => {
    const c = x.s.LEGP_SEMIS;
    const nl = noLowRun(c, x.exit, r.T1_LOW_HOLD_N);
    const ex = x.exit === undefined ? undefined : c.findLast((p) => p.date <= x.exit!);
    if (nl === null || ex === undefined) return NA;
    const px = last(c)!.value!;
    const w = dpCell([[px, nl.low?.value], [px, ex.value]]);
    return { ...allOf([[`no low ${vcAt(px, nl.low, w)}`, nl.got >= r.T1_LOW_HOLD_N], [`>dd-open ${vcAt(px, { value: ex.value!, date: ex.date }, w)}`, px > ex.value!]]), verdict: tick(nl.got >= r.T1_LOW_HOLD_N || px > ex.value!), count: { got: nl.got, need: r.T1_LOW_HOLD_N } };
  },
});
/** The box as a gate row of every tranche: met while `boxHolds` holds nothing; `tally` holds the same guard. One rule text for all three (the quorum clause is prefixed `T2·T3:`), so the row renders once under shared gates until the readings differ. */
const escLeg = (tranche: Tranche, tag: ReadTag): LegDef => ({
  tag,
  key: `${tranche.toLowerCase()}-esc`,
  tranche,
  gate: true,
  leg: "gate: escalation box",
  src: { kind: "dash", id: "F1" },
  rule: () => `no coincident + lead cluster vote · no ${VETO_ROWS.join("/")} block (T1: ${Object.entries(VETO_MEASURED).map(([row, m]) => `${row} once ${m} trips`).join(", ")}) · T2·T3: ≥ ${knob(BOX_KERNEL.QUORUM_SHARE * 100)}% of members live`,
  read: (r, x) => ((e) => ({ value: votesText(e), verdict: tick(!boxHolds(tranche, e)) }))(escalation(x, r)),
});

/** T2·T3 only: BBB OAS — Oracle's and the hyperscalers' bond bucket — the same retrace as HY's rung, armed by a ≥ BBB_MIN_WIDEN widening (`hyRetrace` `floor`);
 *  no BBB close on/before the exit (the series starts 2023-10, so older replay episodes; the live read throws on an empty BBB, `requireBbb`) → met; stale after the exit → n/a, holds. */
const bbbGate = (k: 1 | 2, tag: ReadTag): LegDef => {
  const g = hyRetrace<Rules>(tag, (r) => (k === 1 ? r.T2_RETRACE : r.T3_RETRACE), (r) => (k === 1 ? r.T2_PEAK_AGE_N : 0), { label: "BBB", floor: (r) => r.BBB_MIN_WIDEN });
  return {
    tag,
    key: `t${k + 1}-credit-bbb`,
    tranche: k === 1 ? "T2" : "T3",
    gate: true,
    leg: "gate: credit BBB OAS",
    src: { kind: "dash", id: "BBB" },
    rule: g.rule,
    read: (r, x) =>
      x.exit !== undefined && !x.s.BBB.some((p) => p.date <= x.exit!) ? { value: "no BBB close on/before the exit", verdict: "met" } : g.read(r, { s: { F1: x.s.BBB }, ...(x.exit !== undefined && { exit: x.exit }) }),
  };
};

/** The roster: per tranche the family rungs, then its gates; credit's rung is a gate at every tranche, so each counts the other four (`VOTE_FAMILIES`). */
export const LEGS: readonly LegDef[] = (["T1", "T2", "T3"] as const).flatMap((t, k): LegDef[] => [
  ...Object.values(FAMS).flatMap((f): LegDef[] => (f === CREDIT ? [asGate(CREDIT.rungs[k]!)] : f.rungs[k] ? [f.rungs[k]] : [])),
  ...(k > 0 ? [bbbGate(k as 1 | 2, tagOf({ series: ["BBB"], job: "recovery", agg: "allOf" }))] : []),
  ...(k > 0 ? [capexRollover(t, tagOf({ series: ["HCX"], job: "level", agg: "allOf" }))] : [priceHold(tagOf({ series: ["LEGP_SEMIS"], job: "recovery", agg: "allOf" }))]),
  escLeg(t, tagOf({ series: ["R4", "HCX", "F1", "F8", "VT", "R6", "VXSMH", "T10Y3M_RAW", "CG", "F17"], indicator: "escalation box", job: "composite", agg: "allOf" })),
]);

/** The worst USD/JPY d(YEN_N) over the last YEN_N closes; null short of 2·YEN_N + 1 closes. */
const yenD10 = (c: Pt[], r: Rules): number | null => ((jpy) => (jpy.length > r.YEN_N * 2 ? Math.min(...Array.from({ length: r.YEN_N }, (_, k) => jpy.at(-1 - k)!.value! / jpy.at(-1 - k - r.YEN_N)!.value! - 1)) : null))(closes(c));

/** `boxOf` over `CLUSTERS`: `tripped`/`hits` = the voting clusters, `need` 2 = one coincident + one lead; `families` = the Episode gates rows in `BOX_SIGNS` order (`familyRow`), display only. */
export type Escalation = { tripped: number; need: number; hits: string[]; unread: string[]; families: LadderFamily[]; hold: boolean; holdT2T3: boolean } & Required<Pick<LadderVerdict["escalation"], "clusters" | "veto" | "quorum">>;
/** Per-sign `trips when` text off the rules — never a typed value. */
const BOX_RULE: Record<BoxSign, (r: Rules) => string> = {
  memory_turn: (r) => `MU ≤ −${knob(r.ESC_MU_OFF * 100)}% off ${r.MU_HIGH_N}-close high`,
  taiwan_export: () => "sign block only",
  vxsmh: (r) => `VXSMH > ${knob(r.ESC_VOL_MED_K)}×${r.ESC_VOL_MED_N}d median`,
  curve_10y3m: (r) => `10y−3m < ${r.ESC_CURVE}`,
  cg_drop: (r) => `Cu/Au Δ${r.ESC_CG_N} ≤ ${pct(-r.ESC_CG_DROP)}`,
  yen_carry: (r) => `USD/JPY worst d${r.YEN_N} ≤ ${pct(-r.YEN_DROP)}`,
};
/** Each box family's read tag (`familyRow`'s `opts.tag`): `series` = `BOX_IDS`, `taiwan_export` is sign-only (`manual`). */
export const BOX_TAG: Record<BoxSign, ReadTag> = {
  memory_turn: tagOf({ series: BOX_IDS.memory_turn, job: "relative", agg: "box" }),
  taiwan_export: tagOf({ series: BOX_IDS.taiwan_export, indicator: "Taiwan exports", job: "manual", agg: "box" }),
  vxsmh: tagOf({ series: BOX_IDS.vxsmh, job: "regime", agg: "box" }),
  curve_10y3m: tagOf({ series: BOX_IDS.curve_10y3m, job: "level", agg: "box" }),
  cg_drop: tagOf({ series: BOX_IDS.cg_drop, job: "speed", agg: "box", variant: "pctΔ20" }),
  yen_carry: tagOf({ series: BOX_IDS.yen_carry, job: "speed", agg: "box", variant: "worstΔ10" }),
};
/** Every tagged read the leg emits — the `LEGS` rows by key, the box families by name — for `scripts/lint-ladder-reads.ts` (whose `ACCEPTED` pins the accepted `duplicateReads` groups). */
export const TAGGED_READS: readonly TaggedRead[] = [...LEGS, ...BOX_SIGNS.map((b) => ({ key: b, tag: BOX_TAG[b] }))];
/** A blind close read's cell. */
const UNREAD: Reading = { value: "n/a", verdict: "na" };

/** The ruled box roster (`boxOf`); never in `LADDER_LEGS` or the leg JSON. */
export const CLUSTERS = [
  { name: "equity-vol", kind: "coincident", members: ["vol_flip"] },
  { name: "rates-shock", kind: "lead", members: ["real_yield", "move"] },
  { name: "credit", kind: "coincident", members: ["credit_confirms"] },
  { name: "capex", kind: "lead", members: ["capex_clock"] },
] as const satisfies Roster<"vol_flip" | "real_yield" | "move" | "credit_confirms" | "capex_clock">;
export type Member = (typeof CLUSTERS)[number]["members"][number];
/** Core-driver BLOCK rows: one holds T2·T3 alone, every tranche once its `VETO_MEASURED` member trips (`reachOf`); every other row's block casts no vote. */
export const VETO_ROWS = ["capex_guides"] as const satisfies readonly SignId[];
/** Each veto row's measured half — the box member whose own close read (never OR'd with the row's block) grades its reach; unmapped → T2·T3. */
const VETO_MEASURED: Partial<Record<(typeof VETO_ROWS)[number], Member>> = { capex_guides: "capex_clock" };
/** A member's cell + its Episode gates text: `rule` off the rules, `value` = the read the cell judged. */
export type MemberRead = { cell: Cell; rule: string; value: string };
type Side = { cell: Cell; text: string };
/** One series' half of a member: `none` before its first point, `na` short of `need` closes, else `read` → [hit, text]. */
const sideOf = (name: string, c: Pt[], need: number, read: () => readonly [boolean, string]): Side =>
  !c.length ? { cell: "none", text: `${name} no history` } : c.length < need ? { cell: "na", text: `${name} short of ${need} closes` } : ((ok, text): Side => ({ cell: ok ? "hit" : false, text }))(...read());
/** A member = the Kleene AND of its sides (`kleeneAnd`), their texts joined. */
const memberOf = (rule: string, ...sides: Side[]): MemberRead => ({ cell: kleeneAnd(...sides.map((s) => s.cell)), rule, value: sides.map((s) => s.text).join(" · ") });
/** `MOVE 95.94 > 1.3×72.42`: a close against K × its median, the median printed (never value/cut); `hit` is the caller's verdict. */
const medVs = (name: string, v: number, k: number, med: number, hit: unknown): string => `${name} ${fix(v)} ${hit ? ">" : "≤"} ${knob(k)}×${fix(med)}`;
const bp = (x: number): string => `${x >= 0 ? "+" : ""}${knob(+(x * 100).toFixed(1))}bp`;
/** Each member's ruled read, one series set per member so `readIds` records its own ids. */
const RULED: { [M in Member]: (x: Inputs, r: Rules) => MemberRead } = {
  vol_flip: ({ s: { VT } }, r) =>
    memberOf(`VT ≥ ${knob(r.ESC_VT)} ×${r.ESC_VOL_FLIP_N}`, sideOf("VT", VT, r.ESC_VOL_FLIP_N, () => ((got) => [got >= r.ESC_VOL_FLIP_N, `VT ${fix(last(VT)!.value)} · ≥${knob(r.ESC_VT)} ${got}/${r.ESC_VOL_FLIP_N}`] as const)(quietRun(VT, r.ESC_VOL_FLIP_N, (i) => VT[i]!.value! >= r.ESC_VT - EPS)))),
  real_yield: ({ s: { R4 } }, r) =>
    memberOf(`10y RY Δ${r.ESC_REAL_DELTA_N} ≥ ${bp(r.ESC_REAL_DELTA)}`, sideOf("10y RY", R4, r.ESC_REAL_DELTA_N + 1, () => ((d) => [d >= r.ESC_REAL_DELTA - EPS, `10y RY Δ${r.ESC_REAL_DELTA_N} ${bp(d)}/${bp(r.ESC_REAL_DELTA)}`] as const)(delta(R4, r.ESC_REAL_DELTA_N)!))),
  move: ({ s: { R6 } }, r) =>
    memberOf(
      `MOVE > ${knob(r.ESC_MOVE_MED_K)}×${r.ESC_VOL_MED_N}d median`,
      sideOf("MOVE", R6, r.ESC_VOL_MED_N, () => ((v, med) => ((hit) => [hit, medVs("MOVE", v, r.ESC_MOVE_MED_K, med, hit)] as const)(v > r.ESC_MOVE_MED_K * med + EPS))(last(R6)!.value!, median(vals(R6.slice(-r.ESC_VOL_MED_N))))),
    ),
  credit_confirms: ({ s: { F1 } }, r) => creditConfirms(F1, r),
  capex_clock: ({ s: { HCX } }, r) => memberOf(`HCX < ${pct(r.ESC_HCX)}`, sideOf("HCX", HCX, 1, () => ((v) => [v < r.ESC_HCX - EPS, `HCX ${pct(v)}/${pct(r.ESC_HCX)}`] as const)(last(HCX)!.value!))),
};
const MEMBERS: readonly Member[] = CLUSTERS.flatMap((c) => c.members);
/** Each member's ruled read; `none` = its series has no point on or before the read date (every read site truncates to it). */
export const ruledReads = (x: Inputs, r: Rules): Record<Member, MemberRead> => Object.fromEntries(MEMBERS.map((m) => [m, RULED[m](x, r)])) as Record<Member, MemberRead>;
/** `ruledReads`' cells. */
export const ruledCells = (x: Inputs, r: Rules): Record<Member, Cell> => cellsOf(ruledReads(x, r));
/** The box = `boxOf(CLUSTERS, ruledCells)`; each family row = a Kleene OR of a close read and a read `BOX_ROWS` row's `block` (null = `unread`).
 *  `live` = the latest-print pass: each family row's `live` cell re-reads the box over it, `estTagged` off `s` (`BOX_IDS`) against `at` as the leg rows are. */
export function escalation(x: Inputs, r: Rules, live?: { x: Inputs; s: SeriesSet; at: string }): Escalation {
  const stray = x.signs.find((g) => g.block && !(SIGNS as readonly string[]).includes(g.sign));
  if (stray) throw new Error(`probe:semis-tranches — sign "${stray.sign}" is not a known sign id, so it cannot block`);
  const rowsOf = (b: BoxSign): LadderSign[] => x.signs.filter((g) => (BOX_ROWS[b] as readonly string[]).includes(g.sign) && isRead(g));
  const blockOf = (b: BoxSign): string | false | null => ((rows) => (rows.length ? (rows.find((g) => g.block)?.sign ?? false) : null))(rowsOf(b));
  const either = (b: BoxSign, hit: string | false | null): string | false | null => ((m) => hit || (m && `${b}: \`${m}\` blocks`) || (hit === false && m === false ? false : null))(blockOf(b));
  const { F8, VXSMH, T10Y3M_RAW, CG, F17 } = x.s;
  const muDd = offHigh(F8, r.MU_HIGH_N)?.dd ?? null;
  const memory = muDd === null ? null : muDd <= -r.ESC_MU_OFF + EPS && `memory_turn: MU ${pct(muDd)} off its ${r.MU_HIGH_N}-close high`;
  const medOf = (c: Pt[]) => (c.length < r.ESC_VOL_MED_N ? null : { v: last(c)!.value!, med: median(vals(c.slice(-r.ESC_VOL_MED_N))) });
  const sm = medOf(VXSMH);
  const volHit = (name: BoxSign, o: { v: number; med: number } | null): string | false | null => (o === null ? null : o.v > r.ESC_VOL_MED_K * o.med + EPS && `${name}: ${medVs(INDICATOR[BOX_IDS[name][0]!], o.v, r.ESC_VOL_MED_K, o.med, true)}`);
  const t3m = last(T10Y3M_RAW)?.value ?? null;
  const curve = t3m === null ? null : t3m < r.ESC_CURVE - EPS && `curve_10y3m: 10y−3m ${fix(t3m)} < ${r.ESC_CURVE}`;
  const cgD = CG.length > r.ESC_CG_N ? last(CG)!.value! / CG.at(-1 - r.ESC_CG_N)!.value! - 1 : null;
  const cg = cgD === null ? null : cgD <= -r.ESC_CG_DROP + EPS && `cg_drop: Cu/Au Δ${r.ESC_CG_N} ${pct(cgD)}`;
  const yD = yenD10(F17, r);
  const yen = yD === null ? null : yD <= -r.YEN_DROP + EPS && `yen_carry: USD/JPY worst d${r.YEN_N} ${pct(yD)}`;
  /** The row's close cell off a close hit (`null` = blind → `UNREAD`); `value` is read only when the close exists. */
  const cellOf = (hit: string | false | null, value: () => string): Reading => (hit === null ? UNREAD : { value: value(), verdict: tick(!hit) });
  const signs: { name: BoxSign; close: string | false | null; cell: Reading | null }[] = [
    { name: "memory_turn", close: memory, cell: cellOf(memory, () => `MU ${pct(muDd!)}/${pct(-r.ESC_MU_OFF)}`) },
    { name: "taiwan_export", close: false, cell: null },
    { name: "vxsmh", close: volHit("vxsmh", sm), cell: ((hit) => cellOf(hit, () => medVs("VXSMH", sm!.v, r.ESC_VOL_MED_K, sm!.med, hit)))(volHit("vxsmh", sm)) },
    { name: "curve_10y3m", close: curve, cell: cellOf(curve, () => `10y−3m ${fix(t3m)}/${r.ESC_CURVE}`) },
    { name: "cg_drop", close: cg, cell: cellOf(cg, () => `Cu/Au Δ${r.ESC_CG_N} ${pct(cgD!)}/${pct(-r.ESC_CG_DROP)}`) },
    { name: "yen_carry", close: yen, cell: cellOf(yen, () => `USD/JPY worst d${r.YEN_N} ${pct(yD!)}/${pct(-r.YEN_DROP)}`) },
  ];
  const all = signs.map((g) => ({ name: g.name, hit: BOX_ROWS[g.name].length ? either(g.name, g.close) : g.close, cell: g.cell }));
  /** An unread box sign names its unread rows: `capex_clock (capex_guides)`. */
  const unreadOf = (b: BoxSign): string => ((ids) => (ids.length ? `${b} (${ids.join(", ")})` : b))(BOX_ROWS[b].filter((id) => !rowsOf(b).some((g) => g.sign === id)));
  const liveRows = live && escalation(live.x, r).families;
  const rowsNamed = (ids: readonly SignId[] = []): LadderSign[] => ids.flatMap((id) => x.signs.filter((s) => s.sign === id));
  const signsOf = (b: BoxSign | Member) => rowsNamed([...BOX_ROWS[b], ...(BOX_SHOWN[b] ?? [])]).map(({ sign, lean, block }) => ({ sign, lean, block }));
  const families = all.map((g, i) => ((f) => ({ ...f, signs: signsOf(g.name) }))(familyRow(g.name, BOX_RULE[g.name](r), g.cell, rowsNamed(BOX_ROWS[g.name]), { live: live && g.cell ? estTagged(liveRows![i]!, live.s, BOX_IDS[g.name], live.at) : null, tag: BOX_TAG[g.name] })));
  const reads = ruledReads(x, r);
  const lr = live && { reads: ruledReads(live.x, r), s: live.s, at: live.at };
  const vetoes = VETO_ROWS.filter((id) => x.signs.some((g) => g.sign === id && g.block)).map((name) => ({ name, reach: reachOf(((m) => m !== undefined && reads[m].cell === "hit")(VETO_MEASURED[name]), LADDER_LEGS.semis.blockReach, x.signs.find((g) => g.sign === name)?.blocked?.reach) }));
  const b = boxOf(CLUSTERS, cellsOf(reads), vetoes);
  /** Each member carries its read's `rule`/`value` and its `BOX_ROWS` signs; `live` + `liveCell` only on a latest-print pass, `live` `est.`-tagged off its own series' heads. */
  const clusters = b.clusters.map((c) => ({ ...c, members: c.members.map((m) => ((id) => ({ ...m, rule: reads[id].rule, value: reads[id].value, tag: MEMBER_TAG[id], ...((g) => (g.length ? { signs: g } : {}))(signsOf(id)), ...(lr && { live: estTagged(lr.reads[id], lr.s, MEMBER_IDS[id], lr.at).value, liveCell: lr.reads[id].cell }) }))(m.id as Member)) }));
  return { tripped: b.votes.length, need: 2, hits: b.votes, unread: all.filter((g) => g.hit === null).map((g) => unreadOf(g.name)), families, clusters, veto: b.veto, quorum: { live: b.live, n: b.n, need: b.quorum, t1Only: b.t1Only }, hold: b.hold, holdT2T3: b.holdT2T3 };
}

export type { TrancheResult };
/** Need per tranche over N families: 1 / ⌈FAM_T2_SHARE·N⌉ / ⌈FAM_T3_SHARE·N⌉. */
export const famNeed = (t: Tranche, n: number, r: Rules = SEMIS_RULES): number => famNeedOf(t, n, r);
/** Semis' need: `famNeed` of the voting families, one fewer when an `absorbed` rates rung leaves the count — never an unread one (user 2026-10-20). */
const needOf = (r: Rules, families: number = VOTE_FAMILIES.length): NeedKnobs => ({ shares: r, families, absorbedDrops: true });
/** Ready = every gate met, the box not holding `t` (`boxHolds`), and `famNeed` criteria met (`needOf`). */
export const tally = (t: Tranche, legs: readonly RawLeg[], r: Rules, esc: Escalation, families?: number): TrancheResult => tallyOf(t, legs, esc, needOf(r, families));
const legsAt = (x: Inputs, r: Rules, defs: readonly LegDef[] = LEGS): RawLeg[] => legsOf(x, r, defs);
export const tranchesAt = (x: Inputs, r: Rules): TrancheResult[] => tranchesOf(legsAt(x, r), escalation(x, r), needOf(r));

/** The ids `read` touches, recorded off a dry run over empty series. */
export const readIds = (read: (x: Inputs) => unknown): Id[] => readIdsOf(read, { signs: [], exit: "", start: "" });
/** Each member's series, recorded off its own read. */
const MEMBER_IDS = Object.fromEntries(MEMBERS.map((m) => [m, readIds((y) => RULED[m](y, SEMIS_RULES))])) as Record<Member, Id[]>;
/** Each member's read tag (`escalation` copies it onto the member); `series` = `MEMBER_IDS`, never re-typed. */
const MEMBER_TAG: Record<Member, ReadTag> = {
  vol_flip: tagOf({ series: MEMBER_IDS.vol_flip, job: "level", agg: "box" }),
  real_yield: tagOf({ series: MEMBER_IDS.real_yield, job: "speed", agg: "box", variant: `absΔ${SEMIS_RULES.ESC_REAL_DELTA_N}` }),
  move: tagOf({ series: MEMBER_IDS.move, job: "regime", agg: "box" }),
  credit_confirms: tagOf({ series: MEMBER_IDS.credit_confirms, job: "regime", agg: "box" }),
  capex_clock: tagOf({ series: MEMBER_IDS.capex_clock, job: "level", agg: "box" }),
};
/** Latest prints with null-valued rows dropped once here (`closes` already drops them), so no read sees a null as 0,
 *  and a stale mid-series provisional row dropped — `quietRun`/`last`/`.length` read every row as a session. */
const liveSet = (s: SeriesSet): SeriesSet =>
  eachId(s, (c) => livePrints(c).filter((p) => p.value !== null && !p.provisional));

export type Follow = { exit: string; start: string; fills: (string | null)[]; n: number };
/** Live anchors: the open episode, each tranche's first `firesAt` close after its exit, `n` = closes since; a `latched` fill on/after the exit stays as-is. */
export function followOf(c: SeriesSet, signs: readonly LadderSign[], r: Rules, latched: readonly (string | null)[] = [], events: readonly LadderEventDone[] = []): Follow | null {
  const ep = openEpisode(c);
  if (ep === undefined) return null;
  const { fills } = walkFills(c, ep, signs, r, latched, events);
  return { ...ep, fills, n: c.LEGP_SEMIS.filter((p) => p.date > ep.exit).length };
}
/** The fill walk over `ep` (`followOf`'s loop, `defs` the roster): `fills` = each tranche's first fill, never voided.
 *  `bind` adds `binding` = the closes `boxBinds`; fills unchanged. */
export function walkFills(c: SeriesSet, ep: { exit: string; start: string }, signs: readonly LadderSign[], r: Rules, latched: readonly (string | null)[] = [], events: readonly LadderEventDone[] = [], defs: readonly LegDef[] = LEGS, bind = false): { fills: (string | null)[]; binding?: string[] } {
  const binding: string[] = [];
  const { fills } = walkFollow(ep.exit, c.LEGP_SEMIS.filter((q) => q.date > ep.exit), latched, (d, now) => {
    const x: Inputs = { s: eachId(c, upTo(d)), signs, ...ep };
    const fizzled = allFizzled(events, "T2", d);
    const fired = firesAt(x, r, now, d, fizzled, defs);
    if (bind && boxBinds(x, r, now, d, fizzled, defs)) binding.push(d);
    return fired;
  });
  return { fills, ...(bind && { binding }) };
}
/** A close the box binds: some unfilled tranche it holds (`boxHolds`) that `firesAt` fires with the box cleared — its gate rows dropped, no hold, quorum met. */
export function boxBinds(x: Inputs, r: Rules, fills: readonly (string | null)[], d: string, fizzled: boolean, defs: readonly LegDef[]): boolean {
  const esc = escalation(x, r);
  const free = firesAt(x, r, fills, d, fizzled, defs.filter((g) => !g.key.endsWith("-esc")), clearedBox(esc));
  return (["T1", "T2", "T3"] as const).some((t, i) => fills[i] === null && boxHolds(t, esc) && free[i]);
}
/** Catch-up: the newest SEC0 close above every one of the CATCHUP_HIGH_N before it. */
export const catchUp = (c: Pt[], r: Rules): boolean => c.length > r.CATCHUP_HIGH_N && newExtreme(c, c.length - 1, r.CATCHUP_HIGH_N, "high", { guard: false });
/** Which tranches fire at `d`: own legs ready, or clear on a `catchUp` close — no time route (user 2026-10-12); `fizzled` fires a clear T2 on T1's fill close. */
export function firesAt(x: Inputs, r: Rules, fills: readonly (string | null)[], d: string, fizzled = false, defs: readonly LegDef[] = LEGS, esc: Escalation = escalation(x, r)): boolean[] {
  const legs = legsAt(x, r, defs);
  const high = catchUp(x.s.LEGP_SEMIS, r);
  const out = (["T1", "T2", "T3"] as const).map((t) => ((res) => res.ready || (high && res.clear))(tally(t, legs, r, esc)));
  return fizzleFill(out, fills, d, fizzled, () => tally("T2", legs, r, esc).clear);
}

/** A replayable form: the rules + the roster; `SHIPPED_FORM` = the live verdict's. */
export type Form = { r: Rules; defs: readonly LegDef[] };
export const SHIPPED_FORM: Form = { r: SEMIS_RULES, defs: LEGS };
/** `replaySemis` default + every `--replay` path: the full roster (`LEGS`) under `SEMIS_RULES`. */
export const REPLAY_FORM: Form = { r: SEMIS_RULES, defs: LEGS };
/** Value's `replayValue` over SEC0: per `episodes` exit (`end` = the shared episode end, `episodes`), every id cut PRE_DAYS before the shock through `end`, `walkFills` with no sign rows;
 *  `fills` = each tranche's first fill, a third bought at each, marked at `end`. */
export function replaySemis(s: SeriesSet, k: ReplayKnobs = REPLAY, form: Form = REPLAY_FORM, bind = false): (EpisodeResult & { binding?: string[] })[] {
  const c = eachId(s, closes);
  return episodes(c.LEGP_SEMIS, k).map((e) => {
    const cut = eachId(c, episodeWindow(e, k));
    const walk = walkFills(cut, { exit: e.exit, start: e.shockStart }, [], form.r, [], [], form.defs, bind);
    return { ...scoreEpisode(c.LEGP_SEMIS, e, walk.fills), ...(walk.binding && { binding: walk.binding }) };
  });
}

/** `--replay=why:<window>`: each `replaySemis` fill's own rows at its fill close, routed `count` (criteria met/need) or `catch-up`. */
export function whyFills(s: SeriesSet, k: ReplayKnobs = REPLAY, form: Form = REPLAY_FORM): WhyRow[] {
  const c = eachId(s, closes);
  return replaySemis(s, k, form).flatMap((e) => e.fills.flatMap((d, i): WhyRow[] => {
    if (d === null) return [];
    const t = (["T1", "T2", "T3"] as const)[i]!;
    const x: Inputs = { s: eachId(eachId(c, episodeWindow(e, k)), upTo(d)), signs: [], exit: e.exit, start: e.shockStart };
    const legs = legsAt(x, form.r, form.defs);
    const res = tally(t, legs, form.r, escalation(x, form.r));
    // The replay passes no events, so the fizzle route (`allFizzled`) cannot fire: a fill that is neither is a classification bug.
    const via = res.ready ? `count ${res.metCount}/${res.need}` : res.clear && catchUp(x.s.LEGP_SEMIS, form.r) ? "catch-up" : null;
    if (via === null) throw new Error(`whyFills: ${t} ${d} filled with neither its count nor a catch-up`);
    return [{ exit: e.exit, tranche: t, date: d, trough: e.drops[i]?.trough ?? null, rows: legs.filter((l) => l.tranche === t).map((l) => ({ key: l.key.replace(/^t\d-/, ""), gate: l.gate, verdict: l.verdict })), via }];
  }));
}

/** `tranchesAt`, `met` = `firesAt` over `f` at the newest SEC0 close; a fizzle or catch-up fill names its `via`, a filled tranche carries its fill as `since`. */
export function followed(x: Inputs, r: Rules, f: Follow | null, events: readonly LadderEventDone[] = []): TrancheResult[] {
  const d = last(x.s.LEGP_SEMIS)?.date;
  const fired = f && d ? firesAt({ ...x, exit: f.exit, start: f.start }, r, f.fills, d, allFizzled(events, "T2", d)) : null;
  return followedOf(tranchesAt(x, r), fired, f?.fills, d, (_k, t) => (catchUp(x.s.LEGP_SEMIS, r) && t.clear ? "new high" : "after T1"));
}
/** Whether tranche `t` is ready at SEC0 close `d` with today's signs — `sinceOf`'s walk. */
const readyAt = (t: Tranche, x: Inputs, r: Rules) => (d: string): boolean => ((y: Inputs) => tally(t, legsAt(y, r), r, escalation(y, r)).ready)({ ...x, s: eachId(x.s, upTo(d)) });

/** Read only by the shown-only box rows `vxsmh` (VXSMH) and `yen_carry` (F17): off `VERDICT_IDS`, so neither
 *  THINs a replay, flags `prov.` nor stamps the escalation leg's live cell (`evaluateShipped`). */
const SHOWN_ONLY_IDS: readonly Id[] = ["VXSMH", "F17"];
/** The verdict ids — every `LEGS` row and the box; RS_SMH/F17/VXSMH are display only. */
export const VERDICT_IDS: ReadonlySet<Id> = new Set(readIds((x) => tranchesAt(x, SEMIS_RULES)).filter((id) => !SHOWN_ONLY_IDS.includes(id)));
export const verdictProvisional = (s: SeriesSet): boolean => provisionalOn(VERDICT_IDS, s);

/** Pure: closes give the verdict and the watch (`held` = no open episode), latest prints the `live` column; `prior`'s `filledSince` are the latched fills, `events` feed the fizzle fast fill and the watch. */
export function evaluateShipped(s: SeriesSet, stored: readonly LadderSign[] = [], r: Rules = SEMIS_RULES, prior?: LadderVerdict, events: readonly LadderEventDone[] = [], today?: string) {
  const signs = ((h) => (today ? reviewedSigns(h, events, today) : h))(heldSigns(stored, events)); // a released row holds nothing — a legacy block reads released when its escalation's `spares` names it; `today` = the read day a stale review demotes at
  const c = eachId(s, closes);
  const f = followOf(c, signs, r, prior?.tranches.map((t) => t.filledSince), events);
  const ep = f ?? openEpisode(c);
  const x: Inputs = { s: c, signs, ...(ep && { exit: ep.exit, start: ep.start }) };
  const live: Inputs = { ...x, s: liveSet(s) };
  const asOf = asOfOf(s, readIds((y) => tranchesAt(y, r)));
  const legs: LegResult[] = LEGS.map((d) => ({ key: d.key, tranche: d.tranche, leg: d.leg, rule: d.rule(r), ...(d.foot && { foot: d.foot(r) }), gate: d.gate ?? false, tag: d.tag, ...d.read(r, x), live: estTagged(d.read(r, live), s, readIds((y) => d.read(r, y)).filter((id) => !SHOWN_ONLY_IDS.includes(id)), asOf.live) }));
  const tranches = followed(x, r, f, events).map((t) => ({ ...t, since: t.ready && !t.fill ? sinceOf(x.s.LEGP_SEMIS, readyAt(t.tranche, x, r)) : t.since }));
  return {
    legs,
    asOf,
    tranches,
    tranchesLive: followed(live, r, f, events),
    escalation: escalation(x, r, { x: live, s, at: asOf.live }),
    ...(f && { sessionsSinceExit: f.n }),
    regime: { set: "entry" },
    watch: { held: ep === undefined, ...(ep && { exit: ep.exit }), ...watchLatched(c, signs, events, r) },
  };
}
export type Res = ReturnType<typeof evaluateShipped>;
export const asProbeResult = (res: Res): LadderProbeResult => res;

/** Display-only read (never a criterion, gate or box input): RS_SMH vs its MA_FAST_N MA; USD/JPY prints on the `yen_carry` Episode-gates row. */
export function contextText(s: SeriesSet, r: Rules = SEMIS_RULES): string {
  const rs = closes(s.RS_SMH);
  const m = ma(rs, r.MA_FAST_N);
  return `RS_SMH ${m === null ? "—" : `${pct(last(rs)!.value! / m - 1)} vs MA${r.MA_FAST_N}`} — display only, never a gate`;
}

const LIMIT = 400;
const DEEP_LIMIT = 4000;
/** Ids a build may not serve yet — T10Y3M_RAW — read empty (`na`); any other id's 400 throws. BBB left 2026-11-04: an empty BBB reads its gate met (`bbbGate`), so an unserved one must throw. */
const FORWARD_ONLY: readonly Id[] = ["T10Y3M_RAW"];
export const unservedReadsEmpty = (id: Id, status: number, body: string): boolean => FORWARD_ONLY.includes(id) && status === 400 && body.includes("id must be one of");
/** At DEEP_LIMIT: SEC0 so the `episodes` scan reaches its FROM; F1 and BBB so `shockOf` anchors as replay's. MA200 and the 250-close windows fit LIMIT. */
const DEEP_IDS: readonly Id[] = ["LEGP_SEMIS", "F1", "BBB"];
export const liveLimit = (id: Id): number => (DEEP_IDS.includes(id) ? DEEP_LIMIT : LIMIT);
const fetchSeries = (base: string, id: Id): Promise<Pt[]> => fetchPoints(base, id, liveLimit(id), (status, body) => unservedReadsEmpty(id, status, body));
/** The live read's BBB must carry closes: an empty one would read `bbbGate`'s no-history pass (meant for replay's pre-2023-10 episodes), so it throws instead. */
export const requireBbb = (s: SeriesSet): SeriesSet => {
  if (!s.BBB.length) throw new Error("probe:semis-tranches — BBB came back empty: its T2/T3 gate would pass unread");
  return s;
};
const liveFetch = async (base: string): Promise<SeriesSet> => requireBbb(await fetchEach(SERIES, (id) => fetchSeries(base, id)));

/** `semis:apply`'s re-probe: fetch once, then re-derive off the patched `signs` and the stored verdict's latched fills. */
export async function liveReverdict(base = prodBaseUrl()): Promise<(n: LadderLive) => LadderVerdict> {
  const s = await liveFetch(base);
  const prov = verdictProvisional(s);
  return (n) => toVerdict(evaluateShipped(s, n.signs, SEMIS_RULES, n.verdict, allEvents(n), n.run), prov);
}

const MARK: Record<Verdict, string> = { met: "✓", unmet: "✗", na: "–" };
const CELL_MARK: Record<string, string> = { hit: "✗ HIT", false: "✓", na: "–", none: "none" };
function table(res: Res, s: SeriesSet): string {
  const out: string[] = [];
  for (const [i, t] of (["T1", "T2", "T3"] as const).entries()) {
    out.push(`── ${t} ${"─".repeat(74)}`);
    for (const l of res.legs.filter((x) => x.tranche === t)) out.push(`${l.leg} — ${l.rule}`, `  close  ${l.value}  ${MARK[l.verdict]}`, `  live   ${l.live.value}  ${MARK[l.live.verdict]}`);
    out.push("┄".repeat(80), `${t} total  close  ${probeTrancheCell(res.tranches[i]!)}`, `${"".padEnd(8)}  live   ${probeTrancheCell(res.tranchesLive[i]!)}`, "");
  }
  const e = res.escalation;
  const w = res.watch;
  out.push(
    `escalation box: ${boxStatus(e)} · ${votesText(e)} · watch ${watchGrade(w)}`,
    ...e.clusters.map((c) => `  ${c.name} (${c.kind}) ${c.hits}/${c.live} live of ${c.n}${c.vote ? " — votes" : ""}: ${c.members.map((m) => `${m.id} ${m.value ?? "—"} ${CELL_MARK[String(m.cell)]}`).join(" · ")}`),
    `episode gates (display)${e.unread.length ? ` · unread: ${e.unread.join(", ")}` : ""}`,
    ...e.families.map((f) => `  ${f.name} — ${f.rule}  close ${f.value} ${MARK[f.verdict]}  live ${f.live!.value} ${MARK[f.live!.verdict]}`),
    `drawdown watch: ${watchGrade(w)} · ${w.held ? "none open" : `open since ${w.exit}`}`,
    ...w.rows.map((r) => `  ${r.label} (${r.cluster}) ${r.now} · correction ${r.correction.rule} ${r.correction.cell} · bear ${r.bear.rule} ${r.bear.cell}${r.manual ? " · manual" : ""}`),
    contextText(s),
    `own legs and gates, or a new ${SEMIS_RULES.CATCHUP_HIGH_N}-close SEC0 high with gates clear (T2 also on T1's fill close when every event holding it fizzled)${res.sessionsSinceExit === undefined ? ", no SEC0 drawdown open" : ` — ${res.sessionsSinceExit} closes since the SEC0 drawdown opened`}; signs off ${LADDER_LEGS.semis.json}; live = latest print incl. the intraday head.`,
  );
  return out.join("\n");
}

/** `--replay=` (`replayScorecard`): the Semis scorecard under `REPLAY_FORM`; drift = the identity run (shipped = candidate) — a job plan swaps the candidate, built off `REPLAY_FORM.defs`. */
export const replaySpec: ReplaySpec<SeriesSet> = {
  fund: "LEGP_SEMIS",
  px: "SEC0",
  ids: [...new Set<Id>(["LEGP_SEMIS", ...VERDICT_IDS])],
  trim: (all, f) => eachId(all as SeriesSet, f),
  run: (s, k, bind) => replaySemis(s, k, REPLAY_FORM, bind),
  why: (s, k) => whyFills(s, k),
  head: {
    verdict: "REPLAY_FORM (LEGS) · signs [] (manual rows have no history; the box reads off closes) · exit = `episodes` over SEC0, fill = each tranche's first `firesAt` close",
    drift: "shipped = candidate = REPLAY_FORM (LEGS) · Δ in SEC0 closes",
    why: "REPLAY_FORM · each fill's own rows at its fill close",
    p0: `REPLAY_FORM · binding days = box-held closes that fire with the box cleared; esc = a later SEC0 close ≤ ${BINDING.ESC_FRAC}× the day's by episode end`,
  },
};

const isMain = process.argv[1]?.endsWith("probe-semis-tranches.ts") ?? false;
const replayArg = process.argv.find((a) => a.startsWith("--replay="))?.slice("--replay=".length);
if (isMain && replayArg !== undefined) await replayScorecard(process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl(), replayArg, replaySpec);
if (isMain && replayArg === undefined) {
  const base = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl();
  const into = process.argv.find((a) => a.startsWith("--into="))?.slice("--into=".length);
  const { existsSync, readFileSync } = await import("node:fs");
  const path = into ?? LADDER_LEGS.semis.json;
  const today = isoDay(new Date());
  const live: LadderLive = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LadderLive) : { run: today, rules: [], signs: [], events: [], calendar: [], runs: [] };
  const s = await liveFetch(base);
  const result = evaluateShipped(s, live.signs, SEMIS_RULES, live.verdict, allEvents(live), today);
  if (into !== undefined) {
    const [{ gatesText }, { writeInto }] = await Promise.all([import("../src/ladder-live.js"), import("./ladder-into.js")]);
    const prov = verdictProvisional(s);
    const next = intoLive(live, toVerdict(result, prov));
    const md = writeInto(into, next, "semis");
    const tt = next.verdict!.tranches.map((t) => `${t.id} ${t.met}/${t.total}${gatesText(t.gates)}`).join(" ");
    console.log(`wrote ${into}${md ? ` + ${md}` : ""} · ${tt} · box ${votesText(result.escalation)} · watch ${watchGrade(result.watch)}${prov ? " · prov." : ""}`);
  } else if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(table(result, s));
}
