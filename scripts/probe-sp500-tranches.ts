/**
 * S&P 500 (SXR8) re-entry ladder — four voting families + credit and c1–c4 gates × three tranches, plus the drawdown watch; read-only report.
 * `--replay=holdout|sweep|drift:*|why:*` = `replayScorecard`; `p0:*` throws before any fetch (`replaySpec.deferred`: needs the `firesFrom` split).
 */
import { META } from "../src/api/http.js";
import { heldSigns, reachOf, reviewedSigns } from "../src/ladder-block.js";
import { BOX_KERNEL, boxOf, watchOf, type Cell, type Roster } from "../src/ladder-box.js";
import { delta, ma, maPair, newExtreme, noLowRun, quietRun } from "../src/ladder-jobs.js";
import { allEvents, dpCell, familyRow, fixNum, LEGS as LADDER_LEGS, makeTagOf, probeTrancheCell, toVerdict, vs, type LadderEventDone, type LadderLive, type LadderProbeResult, type LadderSign, type LadderVerdict, type ReadTag, type TaggedRead, type TrancheId, type WatchRow } from "../src/ladder-live.js";
import { addDays, allFizzled } from "../src/ladder-run.js";
import { realFeeds, type FeedPorts } from "../src/feed-ports.js";
import { asGate, CREDIT_FAM, creditRungs, hyRetrace } from "./ladder-credit.js";
import { replayScorecard, type ReplaySpec } from "./ladder-replay-feeds.js";
import { closes, eachSeries, episodes, episodeWindow, fetchEach, knob, last, REPLAY, scoreEpisode, upTo, vals, whyFollow, type Episode, type EpisodeResult, type Pt, type ReplayKnobs, type WhyRow } from "./ladder-replay.js";
import { median } from "./ladder-shock.js";
import { asOfOf, estTagged, fetchPoints, livePrints } from "./probe-eufin-tranches.js";
import { allOf, clusterText, dfiiQuiet, noLowBit, oneRun, partRun, RULED as SPIT_RULED, SPIT_RULES, tenYZ, trendBits, vtRun, type Escalation, type MemberRead } from "./probe-spit-tranches.js";
import { noDrop, VALUE_RULES } from "./probe-value-tranches.js";
import { boxHolds, boxStatus, cellsOf, intoLive, famNeedOf, NO_LINE, sideCell, famRows, fizzleFill, followedOf, isRead, openExitOf, provisionalOn, readIdsOf, sinceOf, tallyOf, tick, tranchesOf, walkFollow, legsOf, type Follow, type NeedKnobs, type RawLeg, type Reading, type TrancheResult, type Verdict } from "./ladder-tranche.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";
export { boxHolds, intoLive } from "./ladder-tranche.js";
export type { Pt };

/** Every `[dash]` input — each a served `/api/series` id (`META`); R5 + SPY feed watch rows only, so they stay out of `VERDICT_IDS`. */
export const SERIES = ["LEGP_SPX", "VT", "F1", "CCC", "R4", "R2", "R6", "F3", "GB", "R5", "SPY", "F2", "F5"] as const;
export type Id = (typeof SERIES)[number];
export type SeriesSet = Record<Id, Pt[]>;
/** Feeds read off their source, not `/api/series` (`claimsFeed`). */
export const LIVE_FEEDS = ["ICSA"] as const;
export type FeedSet = SeriesSet & Partial<Record<(typeof LIVE_FEEDS)[number], Pt[]>>;
export const INDICATOR: Record<Id, string> = { LEGP_SPX: "SXR8", VT: "VIX/VIX3M", F1: "HY OAS", CCC: "CCC OAS", R4: "10y RY", R2: "US 10y", R6: "MOVE", F3: "NFCI Risk", GB: "Global breadth", R5: "VIX", SPY: "SPY", F2: "IG OAS", F5: "QQQ/QQQE" };
const tag = makeTagOf(INDICATOR);
const unserved = SERIES.filter((id) => !META.has(id));
if (unserved.length) throw new Error(`probe:sp500-tranches — not served by /api/series: ${unserved.join(", ")}`);

/** The `signs[].sign` ids the probe knows; a `block` on one outside `BOX_ROWS` throws. */
export const SIGNS = ["hy_oas", "ccc_bb", "ig_oas", "vix", "vix_term", "trend_200d", "nfci_risk", "claims", "contagion", "tech_lead", "breadth", "rates", "earnings", "private_credit", "oil", "context"] as const;
export type SignId = (typeof SIGNS)[number];
export const FAMILIES = ["price", "vol", "credit", "rates", "breadth"] as const;
/** Credit only gates. */
export const VOTE_FAMILIES = FAMILIES.filter((f) => f !== "credit");
export const BOX_SIGNS = ["ig", "tech"] as const;
export type BoxSign = (typeof BOX_SIGNS)[number];
const BOX_ROWS: Record<BoxSign | Member, readonly SignId[]> = { real_yield: ["rates"], credit_confirms: ["hy_oas", "ccc_bb", "private_credit"], vol_flip: ["vix", "vix_term"], ig: ["ig_oas"], tech: ["tech_lead", "earnings"] };

/** Every cut lives here only; credit knobs are Spit's (one value across legs, `CreditRules`). */
export const SP500_RULES = {
  NEED_SLACK: 1,
  FAM_T2_SHARE: 0.4,
  FAM_T3_SHARE: 0.6,
  T1_NO_LOW_N: 5,
  T2_NO_LOW_N: 20,
  MA_FAST_N: 50,
  MA_SLOW_N: 200,
  MA_RISING_N: 10,
  VT_T1_MAX: 1.0,
  VT_T1_N: 3,
  VT_MAX: 0.9,
  VOL_T2_NO_LOW_N: 15,
  VOL_T3_NO_LOW_N: 20,
  VT_T3_N: 10,
  BASE_N: SPIT_RULES.BASE_N,
  SIGMA_N: SPIT_RULES.SIGMA_N,
  BROKE_SD: SPIT_RULES.BROKE_SD,
  T1_RETRACE: SPIT_RULES.T1_RETRACE,
  T2_RETRACE: SPIT_RULES.T2_RETRACE,
  T2_PEAK_AGE_N: SPIT_RULES.T2_PEAK_AGE_N,
  T3_RETRACE: SPIT_RULES.T3_RETRACE,
  ESC_SPREAD_MA_N: SPIT_RULES.ESC_SPREAD_MA_N,
  ESC_HY_MA_K: SPIT_RULES.ESC_HY_MA_K,
  R4_DELTA_N: 63,
  R4_D_MAX: 0.25,
  R4_QUIET_N: 5,
  R2_DELTA_N: 20,
  R2_Z_WINDOW: 250,
  R2_Z_MAX: 1,
  R2_QUIET_N: 5,
  /** Breadth GB = k/7 markets up; T1/T2 unmet while GB < GB_MIN and Δ(GB_DELTA_N) ≤ 0, T3 met at GB ≥ GB_MIN. */
  GB_MIN: 3 / 7,
  GB_DELTA_N: 20,
  G2_MA_N: 200,
  G2_LAG_N: 10,
  C1_HIGH_N: 20,
  C1_T1_N: 5,
  C1_N: 10,
  C2_DELTA_N: 63,
  C2_R4_MAX: 0.5,
  C2_F1_MAX: 0.3,
  C3_DAYS: 91,
  C3_MAX: 0,
  C3_D_MIN: -0.3,
  C4_K: 1.3,
  C4_N: 250,
  VETO_SD: 3,
  VETO_N: 5,
  VETO_SIGMA_N: 60,
  ESC_VT: 1.0,
  ESC_VOL_FLIP_N: 10,
  ESC_REAL_DELTA_N: 120,
  ESC_REAL_DELTA: 0.75,
  TIME_STOP_N: 15,
  T2_AFTER_N: 10,
  T3_AFTER_N: 15,
  /** Watch rows (`SP500_WATCH`): HY · NFCI · VIX · SPY trend · ICSA claims. */
  W_HY_LOW_N: 126,
  W_HY_RISE: 1.0,
  W_HY_BEAR: 4.0,
  W_NFCI_DAYS: 364,
  W_NFCI_RISE: 0.15,
  W_NFCI_BEAR: -0.3,
  W_VIX: 25,
  W_VIX_N: 5,
  W_TREND_N: 3,
  W_MA200_LAG_N: 20,
  W_CLAIMS_N: 4,
  W_CLAIMS_DAYS: 364,
  W_CLAIMS_K: 1.15,
  /** A watch-only feed (R5 · SPY · ICSA) heading more than this many calendar days before `asOf.close` reads ` · stale @MM-DD` (`staleTagged`). */
  W_STALE_DAYS: 5,
  W_STALE_CLAIMS_DAYS: 14,
} as const;
export type Rules = { [K in keyof typeof SP500_RULES]: (typeof SP500_RULES)[K] extends boolean ? boolean : number };

export type Tranche = TrancheId;
export type { Verdict };
export type Inputs = { s: SeriesSet; signs: readonly LadderSign[]; exit?: string };
export type LegDef = { key: string; tranche: Tranche; gate?: boolean; leg: string; src: { kind: "dash"; id: Id }; tag: ReadTag; rule: (r: Rules) => string; foot?: (r: Rules) => string; read: (r: Rules, x: Inputs) => Reading };
export type LegResult = Reading & { key: string; tranche: Tranche; leg: string; rule: string; foot?: string; gate: boolean; live: Reading; tag: ReadTag };

const NA: Reading = { value: "—", verdict: "na" };
const EPS = 1e-9;
const fix = fixNum;
const TR = ["T1", "T2", "T3"] as const;
/** Kleene NOT(a AND b) for a two-condition hold: a known-false half → met, else an unread half → na. */
const notBoth = (a: boolean | null, b: boolean | null): Verdict => (a === false || b === false ? "met" : a === null || b === null ? "na" : "unmet");

type Rung = Pick<LegDef, "rule" | "read" | "tag" | "foot"> & { src?: LegDef["src"]; leg?: string };
export type Fam = { name: (typeof FAMILIES)[number]; rungs: readonly [LegDef, LegDef, LegDef] };
const fam = (name: Fam["name"], leg: string, src: LegDef["src"], rungs: readonly [Rung, Rung, Rung]): Fam => ({ name, rungs: famRows(name, leg, src, rungs) as unknown as Fam["rungs"] });

const PRICE = fam("price", "price SXR8 €", { kind: "dash", id: "LEGP_SPX" }, [
  {
    tag: tag({ series: ["LEGP_SPX"], job: "recovery", agg: "kOfN" }),
    rule: (r) => `no new low since the drawdown opened ×${r.T1_NO_LOW_N}`,
    read: (r, x) => ((c, nl) => (nl === null ? NA : allOf([noLowBit(c, nl, r.T1_NO_LOW_N)], { got: nl.got, need: r.T1_NO_LOW_N })))(x.s.LEGP_SPX, noLowRun(x.s.LEGP_SPX, x.exit, r.T1_NO_LOW_N)),
  },
  {
    tag: tag({ series: ["LEGP_SPX"], job: "composite", agg: "kOfN" }),
    rule: (r) => `no new low since the drawdown opened ×${r.T2_NO_LOW_N} · > MA${r.MA_FAST_N}, MA${r.MA_FAST_N} rising`,
    read: (r, x) => {
      const c = x.s.LEGP_SPX;
      const nl = noLowRun(c, x.exit, r.T2_NO_LOW_N);
      const w = dpCell([[last(c)?.value, nl?.low?.value], [last(c)?.value, ma(c, r.MA_FAST_N)]]);
      const f = trendBits(c, r.MA_FAST_N, r, false, w);
      return nl === null || f === null ? NA : allOf([noLowBit(c, nl, r.T2_NO_LOW_N, false, w), ...f], { got: nl.got, need: r.T2_NO_LOW_N });
    },
  },
  {
    tag: tag({ series: ["LEGP_SPX"], job: "regime", agg: "kOfN" }),
    rule: (r) => `> MA${r.MA_FAST_N} rising · > MA${r.MA_SLOW_N}, MA${r.MA_SLOW_N} rising`,
    read: (r, x) => {
      const c = x.s.LEGP_SPX;
      const w = dpCell([[last(c)?.value, ma(c, r.MA_FAST_N)], [last(c)?.value, ma(c, r.MA_SLOW_N)]]);
      return ((f, s) => (f === null || s === null ? NA : allOf([...f, ...s])))(trendBits(c, r.MA_FAST_N, r, true, w), trendBits(c, r.MA_SLOW_N, r, false, w));
    },
  },
]);

const volRung = (lowN: (r: Rules) => number, vtN: (r: Rules) => number, t: ReadTag): Rung => ({
  tag: t,
  rule: (r) => `no new low since the drawdown opened ×${lowN(r)} · VIX/VIX3M < ${knob(r.VT_MAX)}${vtN(r) > 1 ? ` ×${vtN(r)}` : ""}`,
  read: (r, x) => {
    const nl = noLowRun(x.s.LEGP_SPX, x.exit, lowN(r));
    const [vt, two] = [vtRun(x.s.VT, r.VT_MAX, vtN(r)), vtN(r) > 1];
    if (nl === null || vt === null) return NA;
    return allOf([noLowBit(x.s.LEGP_SPX, nl, lowN(r), two), [`VT ${vt.text}${two ? ` ${vt.got}/${vtN(r)}` : ""}`, vt.ok]], two ? undefined : { got: nl.got, need: lowN(r) });
  },
});
const VOL_TAG = tag({ series: ["LEGP_SPX", "VT"], job: "composite", agg: "kOfN", indicator: "VIX/VIX3M · SXR8" });
const VOL = fam("vol", "vol VIX/VIX3M · SXR8", { kind: "dash", id: "VT" }, [
  {
    tag: tag({ series: ["VT"], job: "level", agg: "kOfN" }),
    rule: (r) => `VIX/VIX3M < ${knob(r.VT_T1_MAX)} ×${r.VT_T1_N}`,
    read: (r, x) => ((b) => (b === null ? NA : allOf([[b.text, b.ok]], { got: b.got, need: r.VT_T1_N })))(vtRun(x.s.VT, r.VT_T1_MAX, r.VT_T1_N)),
  },
  volRung((r) => r.VOL_T2_NO_LOW_N, () => 1, VOL_TAG),
  volRung((r) => r.VOL_T3_NO_LOW_N, (r) => r.VT_T3_N, VOL_TAG),
]);

const [HY_T1, HY_T2, HY_T3] = creditRungs(tag({ series: ["F1"], job: "recovery", agg: "allOf" }));
const CCC_T2 = hyRetrace(tag({ series: ["CCC"], job: "recovery", agg: "allOf" }), (r) => r.T2_RETRACE, () => 0);
/** T2 credit: HY's ½ + age rung AND CCC ½ back from its own shock peak; a CCC n/a passes. */
const CREDIT_T2: Rung = {
  leg: "credit HY OAS · CCC OAS",
  tag: tag({ series: ["F1", "CCC"], job: "recovery", agg: "allOf", indicator: "HY OAS · CCC OAS" }),
  rule: (r) => `${HY_T2.rule(r)} · CCC the same at ½ (n/a passes)`,
  read: (r, x) => {
    const [hy, cc] = [HY_T2.read(r, x), CCC_T2.read(r, { s: { F1: x.s.CCC }, ...(x.exit !== undefined && { exit: x.exit }) })];
    return { value: `HY ${hy.value} · CCC ${cc.value}`, verdict: hy.verdict === "na" ? "na" : tick(hy.verdict === "met" && cc.verdict !== "unmet") };
  },
};
const CREDIT = fam(CREDIT_FAM.name, CREDIT_FAM.leg, CREDIT_FAM.src, [HY_T1, CREDIT_T2, HY_T3]);

const RATES = fam("rates", "rates 10y RY · US 10y", { kind: "dash", id: "R4" }, [
  { tag: tag({ series: ["R4"], job: "speed", agg: "kOfN", variant: "absΔ63" }), rule: (r) => `10y RY Δ${r.R4_DELTA_N} ≤ +${knob(r.R4_D_MAX * 100)}bp ×${r.R4_QUIET_N}`, read: (r, x) => oneRun(dfiiQuiet(x.s.R4, r)) },
  { src: { kind: "dash", id: "R2" }, tag: tag({ series: ["R2"], job: "speed", agg: "kOfN" }), rule: (r) => `10y z(Δ${r.R2_DELTA_N}) < ${knob(r.R2_Z_MAX)} ×${r.R2_QUIET_N}`, read: (r, x) => oneRun(tenYZ(x.s.R2, r)) },
  {
    tag: tag({ series: ["R2", "R4"], job: "speed", agg: "kOfN", indicator: "10y RY · US 10y" }),
    rule: (r) => `10y z(Δ${r.R2_DELTA_N}) < ${knob(r.R2_Z_MAX)} ×${r.R2_QUIET_N} · 10y RY Δ${r.R4_DELTA_N} ≤ +${knob(r.R4_D_MAX * 100)}bp ×${r.R4_QUIET_N}`,
    read: (r, x) => ((z, d) => (z === null || d === null ? NA : allOf([partRun("10y", z), partRun("10y RY", d)])))(tenYZ(x.s.R2, r), dfiiQuiet(x.s.R4, r)),
  },
]);

/** GB vs GB_MIN (`≥` inclusive); `slide` = T1/T2's form, unmet only below the cut with Δ(GB_DELTA_N) ≤ 0. */
const breadthRung = (slide: boolean): Rung => ({
  tag: tag({ series: ["GB"], job: slide ? "composite" : "level", agg: "kOfN" }),
  rule: (r) => (slide ? `not (GB < ${knob(r.GB_MIN * 7)}/7 and Δ${r.GB_DELTA_N} ≤ 0)` : `GB ≥ ${knob(r.GB_MIN * 7)}/7`),
  read: (r, x) => {
    const c = x.s.GB;
    const p = last(c)?.value ?? null;
    if (p === null) return NA;
    const below = p < r.GB_MIN - EPS;
    const d = delta(c, r.GB_DELTA_N);
    const head = `GB ${vs(p, r.GB_MIN, 3).join(below ? "<" : "≥")}`;
    if (!slide) return { value: head, verdict: tick(!below) };
    if (below && d === null) return NA;
    return { value: `${head}${d === null ? "" : ` · Δ${r.GB_DELTA_N} ${d >= 0 ? "+" : ""}${fix(d, 3)}`}`, verdict: tick(!below || d! > 0) };
  },
});
const BREADTH = fam("breadth", "breadth Global breadth", { kind: "dash", id: "GB" }, [breadthRung(true), breadthRung(true), breadthRung(false)]);
export const FAMS = { PRICE, VOL, CREDIT, RATES, BREADTH } as const;

const gateOf = (tranche: Tranche, name: string, leg: string, id: Id, t: ReadTag, rule: LegDef["rule"], read: LegDef["read"]): LegDef => ({ key: `${tranche.toLowerCase()}-${name}`, tranche, gate: true, leg, src: { kind: "dash", id }, tag: t, rule, read });
/** `g2`: holds while SXR8 < MA(G2_MA_N) AND that MA below its level G2_LAG_N closes back. */
const g2Gate = (t: Tranche): LegDef =>
  gateOf(t, "g2", "gate: SXR8 not under a falling MA200", "LEGP_SPX", tag({ series: ["LEGP_SPX"], job: "regime", agg: "allOf" }), (r) => `not (< MA${r.G2_MA_N} and MA${r.G2_MA_N} < its level ${r.G2_LAG_N} closes back)`, (r, x) => {
    const c = x.s.LEGP_SPX;
    const [m, mb] = maPair(c, r.G2_MA_N, r.G2_LAG_N);
    if (m === null || mb === null) return NA;
    const px = last(c)!.value!;
    const [under, falling] = [px < m, m < mb];
    return { value: `${fix(px)} ${under ? "<" : "≥"} MA${r.G2_MA_N} ${fix(m)} · MA ${falling ? "<" : "≥"} ${fix(mb)} (${r.G2_LAG_N} back)`, verdict: tick(!(under && falling)) };
  });
/** `c1`: no new C1_HIGH_N-close HY high for C1_T1_N (T1) / C1_N (T2·T3) closes in a row. */
const c1Gate = (t: Tranche): LegDef =>
  gateOf(t, "c1", "gate: HY OAS no new high", "F1", tag({ series: ["F1"], job: "recovery", agg: "allOf" }), (r) => `no new ${r.C1_HIGH_N}-close HY high ×${t === "T1" ? r.C1_T1_N : r.C1_N}`, (r, x) => {
    const [c, n] = [x.s.F1, t === "T1" ? r.C1_T1_N : r.C1_N];
    if (c.length < r.C1_HIGH_N + n) return NA;
    return oneRun({ text: `HY ${fix(last(c)!.value)} no new ${r.C1_HIGH_N}-close high`, got: quietRun(c, n, (i) => !newExtreme(c, i, r.C1_HIGH_N, "high", { guard: true })), need: n });
  });
/** `c2`: holds while 10y RY Δ(C2_DELTA_N) > C2_R4_MAX AND HY Δ(C2_DELTA_N) > C2_F1_MAX. */
const c2Gate = (t: Tranche): LegDef =>
  gateOf(t, "c2", "gate: no rates + credit spike", "R4", tag({ series: ["R4", "F1"], job: "speed", agg: "allOf", indicator: "10y RY · HY OAS" }), (r) => `not (10y RY Δ${r.C2_DELTA_N} > +${knob(r.C2_R4_MAX * 100)}bp and HY Δ${r.C2_DELTA_N} > +${knob(r.C2_F1_MAX * 100)}bp)`, (r, x) => {
    const [d4, d1] = [delta(x.s.R4, r.C2_DELTA_N), delta(x.s.F1, r.C2_DELTA_N)];
    return { value: `RY Δ${r.C2_DELTA_N} ${vs(d4, r.C2_R4_MAX).join("/")} · HY Δ${r.C2_DELTA_N} ${vs(d1, r.C2_F1_MAX).join("/")}`, verdict: notBoth(d4 === null ? null : d4 > r.C2_R4_MAX + EPS, d1 === null ? null : d1 > r.C2_F1_MAX + EPS) };
  });
/** `c3`: holds while NFCI risk > C3_MAX AND its Δ vs the newest print ≥ C3_DAYS calendar days back > C3_D_MIN. */
const c3Gate = (t: Tranche): LegDef =>
  gateOf(t, "c3", "gate: NFCI risk not tight and rising", "F3", tag({ series: ["F3"], job: "level", agg: "allOf" }), (r) => `not (NFCI risk > ${knob(r.C3_MAX)} and Δ${r.C3_DAYS}d > ${knob(r.C3_D_MIN)})`, (r, x) => {
    const p = last(x.s.F3);
    if (p?.value == null) return NA;
    const base = x.s.F3.filter((q) => q.date <= addDays(p.date, -r.C3_DAYS)).at(-1)?.value ?? null;
    const d = base === null ? null : p.value - base;
    return { value: `NFCI ${vs(p.value, r.C3_MAX, 3).join("/")} · Δ${r.C3_DAYS}d ${vs(d, r.C3_D_MIN, 3).join("/")}`, verdict: notBoth(p.value > r.C3_MAX + EPS, d === null ? null : d > r.C3_D_MIN + EPS) };
  });
/** `c4` (T2·T3): MOVE < C4_K × its C4_N-close median. */
const c4Gate = (t: Tranche): LegDef =>
  gateOf(t, "c4", "gate: MOVE under its median band", "R6", tag({ series: ["R6"], job: "level", agg: "allOf" }), (r) => `MOVE < ${knob(r.C4_K)}× its ${r.C4_N}-close median`, (r, x) => {
    const c = x.s.R6;
    if (c.length < r.C4_N) return NA;
    const cap = r.C4_K * median(vals(c.slice(-r.C4_N)));
    return { value: `MOVE ${vs(last(c)!.value, cap, 1).join("/")}`, verdict: tick(last(c)!.value! < cap - EPS) };
  });
/** Value's veto (`noDrop`) on SXR8: each of the last VETO_N daily log returns ≥ −VETO_SD σ. */
const veto = (t: Tranche): LegDef =>
  gateOf(t, "veto", "veto: no SXR8 crash day", "LEGP_SPX", tag({ series: ["LEGP_SPX"], job: "speed", agg: "allOf", variant: "σret" }), (r) => `SXR8 ≥ −${r.VETO_SD}σ ×${r.VETO_N}`, (r, x) => {
    const p = noDrop(x.s.LEGP_SPX, { ...VALUE_RULES, VETO_SD: r.VETO_SD, VETO_N: r.VETO_N, SIGMA_N: r.VETO_SIGMA_N });
    return p === null ? NA : { value: `${fix(p.ret * 100, 1)}%/-${fix(p.cap * 100, 1)}%`, verdict: tick(p.got >= r.VETO_N), count: { got: p.got, need: r.VETO_N } };
  });
const escLeg = (t: Tranche): LegDef =>
  gateOf(t, "esc", "gate: escalation box", "F1", tag({ series: BOX_SERIES, job: "composite", agg: "allOf", indicator: "escalation box" }), () => `holds on ≥ 1 coincident + ≥ 1 lead cluster vote, or a veto-row block (T1: ${Object.entries(VETO_MEASURED).map(([row, m]) => `${row} once ${m} trips`).join(", ")}) · T2·T3: live ≥ ⌈${knob(BOX_KERNEL.QUORUM_SHARE)}·n⌉`, (r, x) => ((e) => ({ value: clusterText(e), verdict: tick(!boxHolds(t, e)) }))(escalation(x, r)));

const BOX_RULE: Record<BoxSign, string> = { ig: "IG OAS state RED", tech: "QQQ/QQQE state AMBER or RED" };
const BOX_TAG: Record<BoxSign, ReadTag> = { ig: tag({ series: ["F2"], job: "level", agg: "box" }), tech: tag({ series: ["F5"], job: "relative", agg: "box" }) };
const UNREAD: Reading = { value: "n/a", verdict: "na" };

export type MemberId = "real_yield" | "credit_confirms" | "vol_flip";
/** The ruled box roster (`boxOf`). */
export const CLUSTERS = [
  { name: "rates", kind: "lead", members: ["real_yield"] },
  { name: "credit", kind: "coincident", members: ["credit_confirms"] },
  { name: "vol", kind: "coincident", members: ["vol_flip"] },
] as const satisfies Roster<MemberId>;
export type Member = (typeof CLUSTERS)[number]["members"][number];
/** Core-driver BLOCK rows: one holds T2·T3 alone, every tranche once its `VETO_MEASURED` member trips (`reachOf`); every other row's block casts no vote. */
export const VETO_ROWS = ["hy_oas", "ccc_bb", "private_credit", "earnings", "tech_lead"] as const satisfies readonly SignId[];
/** Each veto row's measured half — the box member whose own close read (never OR'd with the row's block) grades its reach; unmapped → T2·T3. `credit_confirms`
 *  reads HY OAS (F1), the index the BB/CCC buckets make up; `private_credit` (BDC marks) has no box series, and `earnings` / `tech_lead` ride the display-only tech row. */
const VETO_MEASURED: Partial<Record<(typeof VETO_ROWS)[number], Member>> = { hy_oas: "credit_confirms", ccc_bb: "credit_confirms" };
export const RULED = {
  real_yield: SPIT_RULED.real_yield,
  credit_confirms: SPIT_RULED.credit_confirms,
  vol_flip: SPIT_RULED.vol_flip,
} satisfies { [M in Member]: (x: Inputs, r: Rules) => MemberRead };
const MEMBERS: readonly Member[] = CLUSTERS.flatMap((c) => c.members);
export const ruledReads = (x: Inputs, r: Rules): Record<Member, MemberRead> => Object.fromEntries(MEMBERS.map((m) => [m, RULED[m](x, r)])) as Record<Member, MemberRead>;
export const ruledCells = (x: Inputs, r: Rules): Record<Member, Cell> => cellsOf(ruledReads(x, r));
/** The ruled box (`boxOf`) + the ig/tech display rows, each a Kleene OR of a close state and a mapped row's `block`. */
export function escalation(x: Inputs, r: Rules): Escalation {
  const boxed = Object.values(BOX_ROWS).flat() as readonly string[];
  const stray = x.signs.find((g) => g.block && !boxed.includes(g.sign));
  if (stray) throw new Error(`probe:sp500-tranches — sign "${stray.sign}" is ${(SIGNS as readonly string[]).includes(stray.sign) ? "context only" : "not a known sign id"}, so it cannot block`);
  const rowsOf = (b: BoxSign): LadderSign[] => x.signs.filter((g) => (BOX_ROWS[b] as readonly string[]).includes(g.sign) && isRead(g));
  const blockOf = (b: BoxSign): string | false | null => ((rows) => (rows.length ? (rows.find((g) => g.block)?.sign ?? false) : null))(rowsOf(b));
  const either = (b: BoxSign, close: string | false | null): string | false | null => ((m) => close || (m && `${b}: \`${m}\` blocks`) || (close === false && m === false ? false : null))(blockOf(b));
  const stateOf = (c: Pt[]): string | null => last(c)?.state ?? null;
  const [ig, tech] = [stateOf(x.s.F2), stateOf(x.s.F5)];
  const closeHit: Record<BoxSign, string | false | null> = { ig: ig === null ? null : ig === "RED" && `ig: IG OAS ${ig}`, tech: tech === null ? null : (tech === "AMBER" || tech === "RED") && `tech: QQQ/QQQE ${tech}` };
  const cellOf = (b: BoxSign, st: string | null): Reading => (closeHit[b] === null ? UNREAD : { value: `${INDICATOR[b === "ig" ? "F2" : "F5"]} ${st}`, verdict: tick(!closeHit[b]) });
  const all = BOX_SIGNS.map((name) => ({ name, hit: either(name, closeHit[name]), cell: cellOf(name, name === "ig" ? ig : tech) }));
  const unreadOf = (b: BoxSign): string => ((ids) => (ids.length ? `${b} (${ids.join(", ")})` : b))(BOX_ROWS[b].filter((id) => !rowsOf(b).some((g) => g.sign === id)));
  const rowsNamed = (b: BoxSign | Member): LadderSign[] => BOX_ROWS[b].flatMap((id) => x.signs.filter((s) => s.sign === id));
  const families = all.map((g) => familyRow(g.name, BOX_RULE[g.name], g.cell, rowsNamed(g.name), { tag: BOX_TAG[g.name] }));
  const reads = ruledReads(x, r);
  const vetoes = VETO_ROWS.filter((id) => x.signs.some((g) => g.sign === id && g.block)).map((name) => ({ name, reach: reachOf(((m) => m !== undefined && reads[m].cell === "hit")(VETO_MEASURED[name]), LADDER_LEGS.sp500.blockReach, x.signs.find((g) => g.sign === name)?.blocked?.reach) }));
  const box = boxOf(CLUSTERS, cellsOf(reads), vetoes);
  const signsOf = (id: Member) => rowsNamed(id).map(({ sign, lean, block }) => ({ sign, lean, block }));
  const clusters = box.clusters.map((c) => ({ ...c, members: c.members.map((m) => ((id) => ({ ...m, rule: reads[id].rule, value: reads[id].value, tag: MEMBER_TAG[id], ...((g) => (g.length ? { signs: g } : {}))(signsOf(id)) }))(m.id as Member)) }));
  return { tripped: box.votes.length, need: 2, hits: box.votes, unread: all.filter((g) => g.hit === null).map((g) => unreadOf(g.name)), families, clusters, veto: box.veto, quorum: { live: box.live, n: box.n, need: box.quorum, t1Only: box.t1Only }, hold: box.hold, holdT2T3: box.holdT2T3 };
}

export type { TrancheResult };
export const famNeed = (t: Tranche, n: number, r: Rules = SP500_RULES): number => famNeedOf(t, n, r);
const needOf = (r: Rules, families: number = VOTE_FAMILIES.length): NeedKnobs => ({ shares: r, families, slack: r.NEED_SLACK });
export const tally = (t: Tranche, legs: readonly RawLeg[], r: Rules, esc: Escalation | null, families?: number): TrancheResult => tallyOf(t, legs, esc, needOf(r, families));
const legsAt = (x: Inputs, r: Rules, defs: readonly LegDef[] = LEGS): RawLeg[] => legsOf(x, r, defs);
export const tranchesAt = (x: Inputs, r: Rules): TrancheResult[] => tranchesOf(legsAt(x, r), escalation(x, r), needOf(r));

const readIds = (read: (x: Inputs) => unknown): Id[] => readIdsOf(read, { signs: [], exit: "" });
const MEMBER_IDS = Object.fromEntries(MEMBERS.map((m) => [m, readIds((y) => RULED[m](y, SP500_RULES))])) as Record<Member, [Id, ...Id[]]>;
const MEMBER_TAG: Record<Member, ReadTag> = {
  real_yield: tag({ series: MEMBER_IDS.real_yield, job: "speed", agg: "box", variant: `absΔ${SP500_RULES.ESC_REAL_DELTA_N}` }),
  credit_confirms: tag({ series: MEMBER_IDS.credit_confirms, job: "regime", agg: "box" }),
  vol_flip: tag({ series: MEMBER_IDS.vol_flip, job: "level", agg: "box" }),
};
const BOX_SERIES = [...new Set([...MEMBERS.flatMap((m) => MEMBER_IDS[m]), ...BOX_SIGNS.flatMap((b) => BOX_TAG[b].series as Id[])])] as [Id, ...Id[]];
/** Per tranche: the family rungs (credit's a gate), then `g2` · `c1` · `c2` · `c3` · `c4` (T2·T3) · veto · esc. */
export const LEGS: readonly LegDef[] = TR.flatMap((t, k): LegDef[] => [
  ...Object.values(FAMS).map((f) => (f === CREDIT ? asGate(CREDIT.rungs[k]!) : f.rungs[k]!)),
  g2Gate(t),
  c1Gate(t),
  c2Gate(t),
  c3Gate(t),
  ...(t === "T1" ? [] : [c4Gate(t)]),
  veto(t),
  escLeg(t),
]);
export const TAGGED_READS: readonly TaggedRead[] = [...LEGS, ...BOX_SIGNS.map((b): TaggedRead => ({ key: b, tag: BOX_TAG[b] }))];
const eachId = (s: SeriesSet, f: (c: Pt[]) => Pt[]): SeriesSet => eachSeries(SERIES, s, f);
const liveSet = (s: SeriesSet): SeriesSet => eachId(s, livePrints);

export type WatchKey = "hy" | "nfci" | "vix" | "trend" | "claims";
type ManualKey = "breadth" | "bb" | "earnings" | "private_credit" | "rates";
export type WatchSet = SeriesSet & Record<(typeof LIVE_FEEDS)[number], Pt[]>;
type WatchSide = WatchRow["correction"];
type WatchDef = { key: WatchKey; label: string; cluster: string; sign: SignId; tag: ReadTag; read: (r: Rules, s: WatchSet) => { now: string; correction: WatchSide; bear: WatchSide } };
type ManualDef = { key: ManualKey; label: string; cluster: string; sign: SignId; manual: true };
const watchTag = makeTagOf<Id | (typeof LIVE_FEEDS)[number]>({ ...INDICATOR, ICSA: "ICSA claims" });
/** The newest point and the low of the points dated within `days` of it; low null when the series is younger than `days`. */
const lowWithin = (c: Pt[], days: number): { p: Pt | undefined; low: number | null } => {
  const p = last(c);
  const since = p ? addDays(p.date, -days) : "";
  return { p, low: p && c[0]!.date <= since ? Math.min(...vals(c.filter((q) => q.date >= since))) : null };
};
/** Drawdown watch rows; a `manual` row shows its sign's lean and never grades. */
export const SP500_WATCH: readonly (WatchDef | ManualDef)[] = [
  {
    key: "hy", label: "HY OAS", cluster: "credit", sign: "hy_oas", tag: watchTag({ series: ["F1"], job: "level", agg: "box" }),
    read: (r, { F1 }) => {
      const v = last(F1)?.value ?? 0;
      const low = F1.length >= r.W_HY_LOW_N ? Math.min(...vals(F1.slice(-r.W_HY_LOW_N))) : null;
      return {
        now: F1.length ? `HY ${fix(v)}${low === null ? "" : ` · low ${fix(low)}`}` : "no history",
        correction: { rule: `≥ ${r.W_HY_LOW_N}-close low + ${knob(r.W_HY_RISE)}`, cell: sideCell(F1, low !== null, () => v >= low! + r.W_HY_RISE - EPS) },
        bear: { rule: `≥ ${knob(r.W_HY_BEAR)}`, cell: sideCell(F1, true, () => v >= r.W_HY_BEAR - EPS) },
      };
    },
  },
  {
    key: "nfci", label: "NFCI risk", cluster: "conditions", sign: "nfci_risk", tag: watchTag({ series: ["F3"], job: "level", agg: "box" }),
    read: (r, { F3 }) => {
      const { p, low } = lowWithin(F3, r.W_NFCI_DAYS);
      const v = p?.value ?? 0;
      return {
        now: p ? `NFCI ${fix(v, 3)}${low === null ? "" : ` · low ${fix(low, 3)}`}` : "no history",
        correction: { rule: `≥ ${r.W_NFCI_DAYS}-day low + ${knob(r.W_NFCI_RISE)}`, cell: sideCell(F3, low !== null, () => v >= low! + r.W_NFCI_RISE - EPS) },
        bear: { rule: `> ${knob(r.W_NFCI_BEAR)}`, cell: sideCell(F3, true, () => v > r.W_NFCI_BEAR + EPS) },
      };
    },
  },
  {
    key: "vix", label: "VIX", cluster: "vol", sign: "vix", tag: watchTag({ series: ["R5"], job: "level", agg: "box" }),
    read: (r, { R5 }) => ({
      now: R5.length ? `VIX ${fix(last(R5)!.value)}` : "no history",
      correction: { rule: `≥ ${knob(r.W_VIX)} ×${r.W_VIX_N}`, cell: sideCell(R5, R5.length >= r.W_VIX_N, () => quietRun(R5, r.W_VIX_N, (i) => R5[i]!.value! >= r.W_VIX - EPS) >= r.W_VIX_N) },
      bear: NO_LINE,
    }),
  },
  {
    key: "trend", label: "SPY trend", cluster: "trend", sign: "trend_200d", tag: watchTag({ series: ["SPY"], job: "regime", agg: "box" }),
    read: (r, { SPY }) => {
      const [m50, m200, back] = [ma(SPY, r.MA_FAST_N), ma(SPY, r.MA_SLOW_N), ma(SPY.slice(0, SPY.length - r.W_MA200_LAG_N), r.MA_SLOW_N)];
      const px = last(SPY)?.value ?? 0;
      const under = (i: number): boolean => ((m) => m !== null && SPY[i]!.value! < m)(ma(SPY.slice(0, i + 1), r.MA_SLOW_N));
      return {
        now: SPY.length ? `SPY ${fix(px)} · MA${r.MA_FAST_N} ${fix(m50)} · MA${r.MA_SLOW_N} ${fix(m200)}` : "no history",
        correction: { rule: `< MA${r.MA_SLOW_N} ×${r.W_TREND_N}`, cell: sideCell(SPY, SPY.length >= r.MA_SLOW_N + r.W_TREND_N - 1, () => quietRun(SPY, r.W_TREND_N, under) >= r.W_TREND_N) },
        bear: { rule: `MA${r.MA_FAST_N} < MA${r.MA_SLOW_N} · MA${r.MA_SLOW_N} < its level ${r.W_MA200_LAG_N} back · < both`, cell: sideCell(SPY, m50 !== null && m200 !== null && back !== null, () => m50! < m200! && m200! < back! && px < m50! && px < m200!) },
      };
    },
  },
  {
    key: "claims", label: "ICSA claims", cluster: "labor", sign: "claims", tag: watchTag({ series: ["ICSA"], job: "level", agg: "box" }),
    read: (r, { ICSA }) => {
      const avgs = ICSA.slice(r.W_CLAIMS_N - 1).map((p, j) => ({ ...p, value: vals(ICSA.slice(j, j + r.W_CLAIMS_N)).reduce((a, b) => a + b, 0) / r.W_CLAIMS_N }));
      const { low } = lowWithin(avgs, r.W_CLAIMS_DAYS); // the 4-wk avg's own low, never a single week's
      const avg = last(avgs)?.value ?? null;
      const k = (v: number | null): string => (v === null ? "—" : `${fix(v / 1000, 0)}k`);
      return {
        now: ICSA.length ? `${r.W_CLAIMS_N}-wk ${k(avg)} · low ${k(low)}` : "no history",
        correction: NO_LINE,
        bear: { rule: `${r.W_CLAIMS_N}-wk avg ≥ ${knob(r.W_CLAIMS_K)}× its ${r.W_CLAIMS_DAYS}-day low`, cell: sideCell(ICSA, avg !== null && low !== null, () => avg! >= r.W_CLAIMS_K * low! - EPS) },
      };
    },
  },
  { key: "breadth", label: "breadth", cluster: "breadth", sign: "breadth", manual: true },
  { key: "bb", label: "CCC−BB", cluster: "credit", sign: "ccc_bb", manual: true },
  { key: "earnings", label: "earnings", cluster: "earnings", sign: "earnings", manual: true },
  { key: "private_credit", label: "private credit", cluster: "credit", sign: "private_credit", manual: true },
  { key: "rates", label: "rates / Fed path", cluster: "rates", sign: "rates", manual: true },
];
/** The watch roster (`watchOf`); manual rows never sit in it. */
export const WATCH_CLUSTERS = [
  { name: "credit", kind: "coincident", members: ["hy"] },
  { name: "vol", kind: "coincident", members: ["vix"] },
  { name: "trend", kind: "coincident", members: ["trend"] },
  { name: "conditions", kind: "lead", members: ["nfci"] },
  { name: "labor", kind: "lead", members: ["claims"] },
] as const satisfies Roster<WatchKey>;
/** Each `SP500_WATCH` row read over `s`, carrying the sign rows its `sign` names. */
export const watchAt = (s: WatchSet, signs: readonly LadderSign[], r: Rules): WatchRow[] =>
  SP500_WATCH.map((d): WatchRow => {
    const g = signs.filter((x) => x.sign === d.sign).map(({ sign, lean, block }) => ({ sign, lean, block }));
    const carried = g.length ? { signs: g } : {};
    if ("manual" in d) return { key: d.key, label: d.label, cluster: d.cluster, now: "—", correction: { rule: "manual", cell: "na" }, bear: { rule: "manual", cell: "na" }, manual: true, ...carried, tag: { indicator: d.label, series: [], job: "manual", agg: "box" } };
    return { key: d.key, label: d.label, cluster: d.cluster, ...d.read(r, s), ...carried, tag: d.tag };
  });

/** Tags a watch-only row's `now` ` · stale @MM-DD` once its feed heads more than its allowance before `close`; never moves a cell. */
export const staleTagged = (rows: WatchRow[], s: WatchSet, close: string, r: Rules): WatchRow[] =>
  rows.map((row) => {
    const id = row.tag?.series.length === 1 ? (row.tag.series[0] as keyof WatchSet) : undefined;
    if (id === undefined || VERDICT_IDS.has(id as Id) || !close) return row;
    const head = s[id]?.at(-1)?.date;
    const allow = id === "ICSA" ? r.W_STALE_CLAIMS_DAYS : r.W_STALE_DAYS;
    return head && (Date.parse(close) - Date.parse(head)) / 864e5 > allow ? { ...row, now: `${row.now} · stale @${head.slice(5)}` } : row;
  });

/** The open `episodes` exit over SXR8 closes; undefined = none open. */
export const openExit = (c: SeriesSet): string | undefined => openExitOf(c.LEGP_SPX);
export type { Follow };
export function followOf(c: SeriesSet, signs: readonly LadderSign[], r: Rules, latched: readonly (string | null)[] = [], events: readonly LadderEventDone[] = []): Follow | null {
  const exit = openExit(c);
  if (exit === undefined) return null;
  return walkFollow(exit, c.LEGP_SPX.filter((p) => p.date > exit), latched, (d, fills) => firesAt({ s: eachId(c, upTo(d)), signs, exit }, r, fills, c.LEGP_SPX, d, allFizzled(events, "T2", d)));
}
/** Which tranches fire at `d`: own legs ready, or clear and T1 TIME_STOP_N closes past `x.exit` / T2·T3 AFTER_N past the fill before. */
export function firesAt(x: Inputs, r: Rules, fills: readonly (string | null)[], px: Pt[], d: string, fizzled = false, defs: readonly LegDef[] = LEGS): boolean[] {
  const [legs, esc] = [legsAt(x, r, defs), escalation(x, r)];
  const out = TR.map((t, k) => {
    const res = tally(t, legs, r, esc);
    if (res.ready) return true;
    if (!res.clear) return false;
    const since = k === 0 ? x.exit : fills[k - 1];
    return since !== null && since !== undefined && px.filter((p) => p.date > since && p.date <= d).length >= [r.TIME_STOP_N, r.T2_AFTER_N, r.T3_AFTER_N][k]!;
  });
  return fizzleFill(out, fills, d, fizzled, () => tally("T2", legs, r, esc).clear);
}
const VIA = ["time stop", "after T1", "after T2"] as const;
export function followed(x: Inputs, r: Rules, f: Follow | null, events: readonly LadderEventDone[] = []): TrancheResult[] {
  const d = last(x.s.LEGP_SPX)?.date;
  const fired = f && d ? firesAt({ ...x, exit: f.exit }, r, f.fills, x.s.LEGP_SPX, d, allFizzled(events, "T2", d)) : null;
  return followedOf(tranchesAt(x, r), fired, f?.fills, d, (k) => VIA[k]!);
}
const readyAt = (t: Tranche, x: Inputs, r: Rules) => (d: string): boolean => ((y: Inputs) => tally(t, legsAt(y, r), r, escalation(y, r)).ready)({ ...x, s: eachId(x.s, upTo(d)) });

/** A replayable form: the rules + the roster; `SHIPPED_FORM` = the live verdict's. */
export type Form = { r: Rules; defs: readonly LegDef[] };
export const SHIPPED_FORM: Form = { r: SP500_RULES, defs: LEGS };
/** No deep history before 2023 — read EMPTY over every replay window, so CCC's T2 half is unjudged (n/a passes → HY-only)
 *  F2/F5 feed only the box's display rows. */
export const REPLAY_BLIND: readonly Id[] = ["CCC", "F2", "F5"];
const blindCloses = (s: SeriesSet): SeriesSet => ({ ...eachId(s, closes), ...Object.fromEntries(REPLAY_BLIND.map((id) => [id, []])) });
/** spit's `replaySpit` over SXR8 with `REPLAY_BLIND` blanked: per `episodes` exit (or each `forced` episode), each tranche's first `firesAt` close after it (fizzled false, no sign rows); a third bought at each fill, marked at `end`. */
export function replaySp500(s: SeriesSet, k: ReplayKnobs = REPLAY, form: Form = SHIPPED_FORM, forced?: readonly Episode[]): EpisodeResult[] {
  const c = blindCloses(s);
  return (forced ?? episodes(c.LEGP_SPX, k)).map((e) => {
    const cut = eachId(c, episodeWindow(e, k));
    const { fills } = walkFollow(e.exit, cut.LEGP_SPX.filter((q) => q.date > e.exit), [], (d, now) => firesAt({ s: eachId(cut, upTo(d)), signs: [], exit: e.exit }, form.r, now, cut.LEGP_SPX, d, false, form.defs));
    return scoreEpisode(c.LEGP_SPX, e, fills);
  });
}
/** `--replay=why:<window>`: `whyFollow` over `replaySp500`, routed `count` (criteria met/need) or its follow `VIA`; an unrouted fill throws. */
export function whyFills(s: SeriesSet, k: ReplayKnobs = REPLAY, form: Form = SHIPPED_FORM): WhyRow[] {
  const c = blindCloses(s);
  return whyFollow(replaySp500(s, k, form), (e) => episodeWindow(e, k)(c.LEGP_SPX), (e, d, t) => {
    const x: Inputs = { s: eachId(eachId(c, episodeWindow(e, k)), upTo(d)), signs: [], exit: e.exit };
    const legs = legsAt(x, form.r, form.defs);
    return { legs, res: tally(t, legs, form.r, escalation(x, form.r)) };
  }, VIA, [form.r.TIME_STOP_N, form.r.T2_AFTER_N, form.r.T3_AFTER_N]);
}

/** The verdict ids — every `LEGS` row and the box; watch-only R5/SPY/ICSA stay out. */
export const VERDICT_IDS: ReadonlySet<Id> = new Set(readIds((x) => tranchesAt(x, SP500_RULES)));
export const verdictProvisional = (s: SeriesSet): boolean => provisionalOn(VERDICT_IDS, s);

/** Pure: closes give the verdict and the watch (with or without an open drawdown, off the follow path's `exit`), latest prints the `live` column. */
export function evaluateShipped(s: FeedSet, stored: readonly LadderSign[] = [], r: Rules = SP500_RULES, prior?: LadderVerdict, events: readonly LadderEventDone[] = [], today?: string) {
  const signs = ((h) => (today ? reviewedSigns(h, events, today) : h))(heldSigns(stored, events)); // a released row holds nothing — a legacy block reads released when its escalation's `spares` names it; `today` = the read day a stale review demotes at
  const c = eachId(s, closes);
  const f = followOf(c, signs, r, prior?.tranches.map((t) => t.filledSince), events);
  const exit = f?.exit ?? openExit(c);
  const x: Inputs = { s: c, signs, ...(exit !== undefined && { exit }) };
  const live: Inputs = { ...x, s: liveSet(s) };
  const asOf = asOfOf(s, readIds((y) => tranchesAt(y, r)));
  const legs: LegResult[] = LEGS.map((d) => ({ key: d.key, tranche: d.tranche, leg: d.leg, rule: d.rule(r), ...(d.foot && { foot: d.foot(r) }), gate: d.gate ?? false, tag: d.tag, ...d.read(r, x), live: estTagged(d.read(r, live), s, readIds((y) => d.read(r, y)), asOf.live) }));
  const tranches = followed(x, r, f, events).map((t) => ({ ...t, since: t.ready && !t.fill ? sinceOf(x.s.LEGP_SPX, readyAt(t.tranche, x, r)) : t.since }));
  const w: WatchSet = { ...c, ICSA: closes(s.ICSA ?? []) };
  const rows = staleTagged(watchAt(w, signs, r), w, asOf.close, r);
  return {
    legs,
    asOf,
    tranches,
    tranchesLive: followed(live, r, f, events),
    escalation: escalation(x, r),
    ...(f && { sessionsSinceExit: f.n }),
    regime: { set: "entry" },
    watch: { held: exit === undefined, ...(exit && { exit }), rows, ...watchOf(WATCH_CLUSTERS, rows) },
  };
}
export type Res = ReturnType<typeof evaluateShipped>;
export const asProbeResult = (res: Res): LadderProbeResult => res;

const LIMIT = 400;
const DEEP_LIMIT = 4000;
/** At DEEP_LIMIT: SXR8 for `episodes`, F1/CCC for `shockOf`. */
const DEEP_IDS: readonly Id[] = ["LEGP_SPX", "F1", "CCC"];
export const liveLimit = (id: Id): number => (DEEP_IDS.includes(id) ? DEEP_LIMIT : LIMIT);
/** ICSA off FRED (`realFeeds.fetchSeries`) since `now` − 730 days; a fetch error throws, like every `/api/series` input — an empty feed would drop the claims row from the watch box and move the grade (a false push). */
export async function claimsFeed(get: FeedPorts["fetchSeries"] = realFeeds.fetchSeries, now = new Date()): Promise<Pt[]> {
  return (await get("ICSA", { since: addDays(isoDay(now), -730), now, env: readEnv() })).map(({ date, value }) => ({ date, value }));
}
async function liveFetch(base: string): Promise<FeedSet> {
  const [s, ICSA] = await Promise.all([fetchEach(SERIES, (id) => fetchPoints(base, id, liveLimit(id))), claimsFeed()]);
  return { ...s, ICSA };
}

export async function liveReverdict(base = prodBaseUrl()): Promise<(n: LadderLive) => LadderVerdict> {
  const s = await liveFetch(base);
  const prov = verdictProvisional(s);
  return (n) => toVerdict(evaluateShipped(s, n.signs, SP500_RULES, n.verdict, allEvents(n), n.run), prov);
}

const MARK: Record<Verdict, string> = { met: "✓", unmet: "✗", na: "–" };
function table(res: Res): string {
  const out: string[] = [];
  for (const [i, t] of TR.entries()) {
    out.push(`── ${t} ${"─".repeat(74)}`);
    for (const l of res.legs.filter((x) => x.tranche === t)) out.push(`${l.leg} — ${l.rule}`, `  close  ${l.value}  ${MARK[l.verdict]}`, `  live   ${l.live.value}  ${MARK[l.live.verdict]}`);
    out.push("┄".repeat(80), `${t} total  close  ${probeTrancheCell(res.tranches[i]!)}`, `${"".padEnd(8)}  live   ${probeTrancheCell(res.tranchesLive[i]!)}`, "");
  }
  const e = res.escalation;
  const w = res.watch;
  out.push(
    `escalation box: ${boxStatus(e)} · ${clusterText(e)}${e.unread.length ? ` · unread: ${e.unread.join(", ")}` : ""}`,
    ...e.clusters.map((c) => `  ${c.name} (${c.kind}) ${c.hits}/${c.live} live of ${c.n}${c.vote ? " — votes" : ""} · ${c.members.map((m) => `${m.id} ${m.value ?? "—"}`).join(" · ")}`),
    `drawdown watch: ${w.grade} · ${w.held ? "none open" : `open since ${w.exit}`}`,
    ...w.rows.map((r) => `  ${r.label} (${r.cluster}) ${r.now} · correction ${r.correction.rule} ${r.correction.cell} · bear ${r.bear.rule} ${r.bear.cell}${r.manual ? " · manual" : ""}`),
    `own legs and gates, or the follow path (time stop · after T1 · after T2)${res.sessionsSinceExit === undefined ? ", no SXR8 drawdown open" : ` — ${res.sessionsSinceExit} closes since the SXR8 drawdown opened`}; signs off ${LADDER_LEGS.sp500.json}; live = latest print incl. the intraday head.`,
  );
  return out.join("\n");
}

/** `--replay=` (`replayScorecard`): the S&P 500 scorecard over the verdict ids less `REPLAY_BLIND` (read empty, never fetched); drift = the identity run (shipped = candidate = `SHIPPED_FORM`); no `p0` head. */
export const replaySpec: ReplaySpec<SeriesSet> = {
  fund: "LEGP_SPX",
  px: "SXR8",
  ids: [...new Set<Id>(["LEGP_SPX", ...[...VERDICT_IDS].filter((id) => !REPLAY_BLIND.includes(id))])],
  trim: (all, f) => eachId(all as SeriesSet, f),
  run: (s, k) => replaySp500(s, k, SHIPPED_FORM),
  why: (s, k) => whyFills(s, k),
  head: {
    verdict: `SP500_RULES + LEGS · signs [] (manual rows have no history; the box reads off closes) · blind ${REPLAY_BLIND.join(", ")} (read empty: CCC's T2 half unjudged) · exit = \`episodes\` over SXR8, fill = each tranche's first \`firesAt\` close`,
    drift: "shipped = candidate = SHIPPED_FORM (SP500_RULES + LEGS) · Δ in SXR8 closes",
    why: "SHIPPED_FORM · each fill's own rows at its fill close",
  },
  deferred: "sp500 p0 needs its firesAt split into the firesFrom shape",
};

const isMain = process.argv[1]?.endsWith("probe-sp500-tranches.ts") ?? false;
const replayArg = process.argv.find((a) => a.startsWith("--replay="))?.slice("--replay=".length);
if (isMain && replayArg !== undefined) await replayScorecard(process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl(), replayArg, replaySpec);
if (isMain && replayArg === undefined) {
  const base = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl();
  const into = process.argv.find((a) => a.startsWith("--into="))?.slice("--into=".length);
  const { existsSync, readFileSync } = await import("node:fs");
  const path = into ?? LADDER_LEGS.sp500.json;
  const today = isoDay(new Date());
  const live: LadderLive = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LadderLive) : { run: today, rules: [], signs: [], events: [], calendar: [], runs: [] };
  const s = await liveFetch(base);
  const result = evaluateShipped(s, live.signs, SP500_RULES, live.verdict, allEvents(live), today);
  if (into !== undefined) {
    const [{ gatesText }, { writeInto }] = await Promise.all([import("../src/ladder-live.js"), import("./ladder-into.js")]);
    const prov = verdictProvisional(s);
    const next = intoLive(live, toVerdict(result, prov));
    const md = writeInto(into, next, "sp500");
    const tt = next.verdict!.tranches.map((t) => `${t.id} ${t.met}/${t.total}${gatesText(t.gates)}`).join(" ");
    console.log(`wrote ${into}${md ? ` + ${md}` : ""} · ${tt} · box ${clusterText(result.escalation)} · watch ${result.watch.grade}${prov ? " · prov." : ""}`);
  } else if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(table(result));
}
