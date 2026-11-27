/**
 * S&P IT (QDVE) re-entry ladder — four voting families + a credit gate (`ladder-credit.ts`) × three tranches over prod `/api/series` plus the `signs[]` rows of `public/spit.json`;
 * read-only report, `--into=` writes `verdict` only (+ re-renders `docs/spit.md` on the canonical path, `ladder-into.ts`). Cuts = `SPIT_RULES`; shape = the Semis probe's family ladder.
 */
import { META } from "../src/api/http.js";
import { heldSigns, reachOf, reviewedSigns } from "../src/ladder-block.js";
import { BOX_KERNEL, boxOf, type Cell, type Roster } from "../src/ladder-box.js";
import { allEvents, dpCell, familyRow, fixNum, LEGS as LADDER_LEGS, makeTagOf, mmdd, pctVs, probeTrancheCell, toVerdict, vcAt, vs, zVs, type LadderEventDone, type LadderFamily, type LadderLive, type LadderProbeResult, type LadderSign, type LadderVerdict, type ReadTag, type TaggedRead, type TrancheId, type Via } from "../src/ladder-live.js";
import { delta, ma, maPair, noLowRun, offHigh, quietRun, speedQuiet, SPIT_YEN_GATE } from "../src/ladder-jobs.js";
import { allFizzled } from "../src/ladder-run.js";
import { asGate, CREDIT_FAM, creditConfirms, creditRungs } from "./ladder-credit.js";
import { replayScorecard, type ReplaySpec } from "./ladder-replay-feeds.js";
import { BINDING, episodes, scoreEpisode, REPLAY, eachSeries, episodeWindow, fetchEach, knob, last, pct, upTo, vals, whyFollow, type EpisodeResult, type ReplayKnobs, type WhyRow } from "./ladder-replay.js";
import { asOfOf, closes, estTagged, livePrints, fetchPoints, type Pt } from "./probe-eufin-tranches.js";
import { guardAnchor, HALF, hybridLine, shockOffHigh } from "./ladder-shock.js";
import { noDrop, VALUE_RULES } from "./probe-value-tranches.js";
import { boxHolds, boxStatus, famNeedOf, fizzleFill, followedOf, intoLive, legsOf, openExitOf, walkFollow, type Follow, provisionalOn, readIdsOf, tallyOf, tranchesOf, cellsOf, famRows, isRead, shortOf, sinceOf, tick, type NeedKnobs, type RawLeg, type Reading, type TrancheResult, type Verdict } from "./ladder-tranche.js";
import { isoDay } from "../src/dates.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";
export { boxHolds, intoLive } from "./ladder-tranche.js";
export type { Pt };

/** Every `[dash]` input — each must be a served `/api/series` id (`META`); anything else is a `[manual]` sign row. */
export const SERIES = ["LEGP_SPIT", "VT", "F1", "R4", "R2", "HCX", "RS_SMH", "LEGP_SEMIS", "RS_XLK", "F17"] as const;
export type Id = (typeof SERIES)[number];
export type SeriesSet = Record<Id, Pt[]>;
/** Series id → the leg's ONE canonical name (`ReadTag.indicator`); a multi-series row names its indicator by hand at the call site. */
export const INDICATOR: Record<Id, string> = { LEGP_SPIT: "QDVE", VT: "VIX/VIX3M", F1: "HY OAS", R4: "10y RY", R2: "US 10y", HCX: "HCX", RS_SMH: "RS_SMH", LEGP_SEMIS: "SEC0", RS_XLK: "RS_XLK", F17: "USD/JPY" };
/** A row's read tag off its call-site choice — the shared builder (`makeTagOf`, src/ladder-live.ts): `indicator` derives from `INDICATOR` for a single series; a multi-series row names it (throws at load otherwise). */
const tag = makeTagOf(INDICATOR);
const unserved = SERIES.filter((id) => !META.has(id));
if (unserved.length) throw new Error(`probe:spit-tranches — not served by /api/series: ${unserved.join(", ")}`);

/** The `signs[].sign` ids the probe knows; a `block` on one outside `BOX_ROWS` (`antitrust`, or an unknown id) throws. */
export const SIGNS = ["rates", "credit", "ai_funding", "hyper_capex", "ai_anchors", "azure_capacity", "it_revisions", "aapl_demand", "jpy_carry", "crowding", "semi_policy", "antitrust"] as const;
export type SignId = (typeof SIGNS)[number];
/** The ladder's families, one rung per tranche each (`FAMS`). */
export const FAMILIES = ["price", "vol", "credit", "rates", "capex"] as const;
/** The families a tranche counts (`famNeed`'s N); credit only gates. */
export const VOTE_FAMILIES = FAMILIES.filter((f) => f !== "credit");
/** The Episode gates display rows (`escalation().families`); they cast no vote — a row duplicating a `CLUSTERS` member is that member, never a family. */
export const BOX_SIGNS = ["earnings", "yen", "policy"] as const;
export type BoxSign = (typeof BOX_SIGNS)[number];
/** Each box row's sign rows: a family's read `block` trips it; a member carries them (`signs`) and its cell stays its ruled read. */
const BOX_ROWS: Record<BoxSign | Member, readonly SignId[]> = { real_yield: ["rates"], credit_confirms: ["credit", "ai_funding"], hcx_red: ["hyper_capex", "ai_anchors", "azure_capacity"], vol_flip: [], earnings: ["it_revisions", "aapl_demand"], yen: ["jpy_carry", "crowding"], policy: ["semi_policy"] };

/** Every cut lives here only. F1/R4/R2 are % levels (Δ in pct pts); VT a ratio; fractions are drawdowns off a high. */
export const SPIT_RULES = {
  NEED_SLACK: 1,
  FAM_T2_SHARE: 0.4,
  FAM_T3_SHARE: 0.6,
  T1_NO_LOW_N: 5,
  T2_NO_LOW_N: 20,
  MA_FAST_N: 50,
  MA_SLOW_N: 200,
  /** [default] MA rising = MA now above the MA this many closes back (Value's `MA_RISING_LAG`). */
  MA_RISING_N: 10,
  VT_T1_MAX: 1.0,
  VT_T1_N: 3,
  VT_MAX: 0.9,
  VOL_T2_NO_LOW_N: 15,
  VOL_T3_NO_LOW_N: 20,
  VT_T3_N: 10,
  /** credit gate T1–T3 (`hyRetrace`, `ladder-credit.ts`) off HY's own `shockOf`: base = median of BASE_N closes, σ over SIGMA_N Δ, opens on a BROKE_SD σ rise.
   *  HY back T1/T2/T3_RETRACE of peak → base (T2: peak ≥ T2_PEAK_AGE_N closes old); closed before the exit → met; none ever opened → n/a. */
  BASE_N: 20,
  SIGMA_N: 60,
  BROKE_SD: 3,
  T1_RETRACE: 1 / 3,
  T2_RETRACE: 1 / 2,
  T2_PEAK_AGE_N: 10,
  T3_RETRACE: 2 / 3,
  R4_DELTA_N: 63,
  R4_D_MAX: 0.25,
  R4_QUIET_N: 5,
  R2_DELTA_N: 20,
  R2_Z_WINDOW: 250,
  R2_Z_MAX: 1,
  R2_QUIET_N: 5,
  SEMIS_HIGH_N: 60,
  SEMIS_OFF_MAX: 0.1,
  RS_FAST_N: 10,
  RS_SLOW_N: 50,
  G1_HIGH_N: 252,
  G1_FRAC: 0.85,
  G1_MA_N: 200,
  VETO_SD: 3,
  VETO_N: 5,
  VETO_SIGMA_N: 60,
  ESC_RS_LOW_N: 60,
  ESC_JPY_N: SPIT_YEN_GATE.n,
  ESC_JPY_DROP: SPIT_YEN_GATE.drop,
  /** Ruled box member cuts (`ruledCells`): VT ≥ ESC_VT ×ESC_VOL_FLIP_N · DFII10 Δ(ESC_REAL_DELTA_N) ≥ ESC_REAL_DELTA ·
   *  HY ≥ ESC_HY_MA_K × MA(ESC_SPREAD_MA_N) — the Semis probe's values. */
  ESC_VT: 1.0,
  ESC_VOL_FLIP_N: 10,
  ESC_REAL_DELTA_N: 120,
  ESC_REAL_DELTA: 0.75,
  ESC_SPREAD_MA_N: 200,
  ESC_HY_MA_K: 1.1,
  TIME_STOP_N: 15,
  T2_AFTER_N: 10,
  T3_AFTER_N: 15,
  /** Hybrid guard: the RS_XLK box low breaks on its since-shock line while its own shock is open; false = rolling only. */
  HYBRID_GUARDS: true,
} as const;
export type Rules = { [K in keyof typeof SPIT_RULES]: (typeof SPIT_RULES)[K] extends boolean ? boolean : number };

export type Tranche = TrancheId;
export type { Verdict };
/** `exit` = the open episode's exit (`openExit`) — every post-exit read anchors on it; absent, they read n/a. */
export type Inputs = { s: SeriesSet; signs: readonly LadderSign[]; exit?: string };
/** `foot` = a clause shared across rows (`VerdictLeg.foot`), a numbered footnote on the expected cell. */
export type LegDef = { key: string; tranche: Tranche; gate?: boolean; leg: string; src: { kind: "dash"; id: Id }; tag: ReadTag; rule: (r: Rules) => string; foot?: (r: Rules) => string; read: (r: Rules, x: Inputs) => Reading };
export type LegResult = Reading & { key: string; tranche: Tranche; leg: string; rule: string; foot?: string; gate: boolean; live: Reading; tag: ReadTag };

const NA: Reading = { value: "—", verdict: "na" };
const EPS = 1e-9;
const fix = fixNum;
const deltaAt = (c: Pt[], i: number, n: number): number | null => (i >= n ? c[i]!.value! - c[i - n]!.value! : null);
export type Bit = readonly [string, boolean];
/** A lone bit with a count prints no mark of its own: the trailing `✓ got/need` is it. */
export const allOf = (bits: readonly Bit[], count?: Reading["count"]): Reading => ({ value: bits.map(([t, ok]) => (bits.length === 1 && count ? t : `${t}${ok ? "✓" : "✗"}`)).join(" · "), verdict: tick(bits.every(([, ok]) => ok)), ...(count && { count }) });

/** `inline` = a row counting two runs: each part carries its own got/n. */
export const noLowBit = (c: Pt[], nl: NonNullable<ReturnType<typeof noLowRun>>, n: number, inline = false, w = 2): Bit => [`no low ${vcAt(last(c)!.value, nl.low, w)}${inline ? ` ${nl.got}/${n}` : ""}`, nl.got >= n];
/** Close > MA(n) and that MA rising; `px` prints the close where no earlier bit does; `w` = the cell's one width; null short of history. */
export const trendBits = (c: Pt[], n: number, r: Pick<Rules, "MA_RISING_N">, px = false, w = 2): Bit[] | null => {
  const [m, mb] = maPair(c, n, r.MA_RISING_N);
  if (m === null || mb === null) return null;
  const [p, mp] = vs(last(c)!.value, m, w);
  return [[`${px ? p : ""}>MA${n} ${mp}`, last(c)!.value! > m], [`MA${n} Δ${r.MA_RISING_N} ${vs(m - mb, 0, 3)[0]}>0`, m > mb]];
};

type Rung = Pick<LegDef, "rule" | "read" | "tag" | "foot"> & { src?: LegDef["src"]; leg?: string };
export type Fam = { name: (typeof FAMILIES)[number]; rungs: readonly [LegDef, LegDef, LegDef] };
/** One family = one rung per tranche, keyed `t<k>-<name>`. */
const fam = (name: Fam["name"], leg: string, src: LegDef["src"], rungs: readonly [Rung, Rung, Rung]): Fam => ({
  name,
  rungs: famRows(name, leg, src, rungs) as unknown as Fam["rungs"],
});

const PRICE = fam("price", "price QDVE €", { kind: "dash", id: "LEGP_SPIT" }, [
  {
    tag: tag({ series: ["LEGP_SPIT"], job: "recovery", agg: "kOfN" }),
    rule: (r) => `no new low since the drawdown opened ×${r.T1_NO_LOW_N}`,
    read: (r, x) => ((c, nl) => (nl === null ? NA : allOf([noLowBit(c, nl, r.T1_NO_LOW_N)], { got: nl.got, need: r.T1_NO_LOW_N })))(x.s.LEGP_SPIT, noLowRun(x.s.LEGP_SPIT, x.exit, r.T1_NO_LOW_N)),
  },
  {
    tag: tag({ series: ["LEGP_SPIT"], job: "composite", agg: "kOfN" }),
    rule: (r) => `no new low since the drawdown opened ×${r.T2_NO_LOW_N} · > MA${r.MA_FAST_N}, MA${r.MA_FAST_N} rising`,
    read: (r, x) => {
      const c = x.s.LEGP_SPIT;
      const nl = noLowRun(c, x.exit, r.T2_NO_LOW_N);
      const w = dpCell([[last(c)?.value, nl?.low?.value], [last(c)?.value, ma(c, r.MA_FAST_N)]]);
      const f = trendBits(c, r.MA_FAST_N, r, false, w);
      return nl === null || f === null ? NA : allOf([noLowBit(c, nl, r.T2_NO_LOW_N, false, w), ...f], { got: nl.got, need: r.T2_NO_LOW_N });
    },
  },
  {
    tag: tag({ series: ["LEGP_SPIT"], job: "regime", agg: "kOfN" }),
    rule: (r) => `> MA${r.MA_FAST_N} rising · > MA${r.MA_SLOW_N}, MA${r.MA_SLOW_N} rising`,
    read: (r, x) => {
      const c = x.s.LEGP_SPIT;
      const w = dpCell([[last(c)?.value, ma(c, r.MA_FAST_N)], [last(c)?.value, ma(c, r.MA_SLOW_N)]]);
      return ((f, s) => (f === null || s === null ? NA : allOf([...f, ...s])))(trendBits(c, r.MA_FAST_N, r, true, w), trendBits(c, r.MA_SLOW_N, r, false, w));
    },
  },
]);

/** VIX/VIX3M under `max` for `n` closes in a row (`text` = `0.98<1`); null short of `n` closes. */
export const vtRun = (c: Pt[], max: number, n: number): { text: string; got: number; ok: boolean } | null =>
  c.length < n ? null : ((got) => ({ text: `${vs(last(c)!.value, max)[0]}<${knob(max)}`, got, ok: got >= n }))(quietRun(c, n, (i) => c[i]!.value! < max));
const volRung = (lowN: (r: Rules) => number, vtN: (r: Rules) => number, t: ReadTag): Rung => ({
  tag: t,
  rule: (r) => `no new low since the drawdown opened ×${lowN(r)} · VIX/VIX3M < ${knob(r.VT_MAX)}${vtN(r) > 1 ? ` ×${vtN(r)}` : ""}`,
  read: (r, x) => {
    const nl = noLowRun(x.s.LEGP_SPIT, x.exit, lowN(r));
    const [vt, two] = [vtRun(x.s.VT, r.VT_MAX, vtN(r)), vtN(r) > 1];
    if (nl === null || vt === null) return NA;
    return allOf([noLowBit(x.s.LEGP_SPIT, nl, lowN(r), two), [`VT ${vt.text}${two ? ` ${vt.got}/${vtN(r)}` : ""}`, vt.ok]], two ? undefined : { got: nl.got, need: lowN(r) });
  },
});
const VOL = fam("vol", "vol VIX/VIX3M · QDVE", { kind: "dash", id: "VT" }, [
  {
    tag: tag({ series: ["VT"], job: "level", agg: "kOfN" }),
    rule: (r) => `VIX/VIX3M < ${knob(r.VT_T1_MAX)} ×${r.VT_T1_N}`,
    read: (r, x) => ((b) => (b === null ? NA : allOf([[b.text, b.ok]], { got: b.got, need: r.VT_T1_N })))(vtRun(x.s.VT, r.VT_T1_MAX, r.VT_T1_N)),
  },
  volRung((r) => r.VOL_T2_NO_LOW_N, () => 1, tag({ series: ["LEGP_SPIT", "VT"], job: "composite", agg: "kOfN", indicator: "VIX/VIX3M · QDVE" })),
  volRung((r) => r.VOL_T3_NO_LOW_N, (r) => r.VT_T3_N, tag({ series: ["LEGP_SPIT", "VT"], job: "composite", agg: "kOfN", indicator: "VIX/VIX3M · QDVE" })),
]);

const CREDIT = fam(CREDIT_FAM.name, CREDIT_FAM.leg, CREDIT_FAM.src, creditRungs(tag({ series: ["F1"], job: "recovery", agg: "allOf" })));

export type Run = { text: string; got: number; need: number };
/** A one-run row: the count trails (`count`); in a two-run row each part names its series and carries its got/need. */
export const oneRun = (u: Run | null): Reading => (u === null ? NA : allOf([[u.text, u.got >= u.need]], { got: u.got, need: u.need }));
export const partRun = (id: string, u: Run): Bit => [`${id} ${u.text} ${u.got}/${u.need}`, u.got >= u.need];
/** DFII10 Δ(R4_DELTA_N) ≤ R4_D_MAX for R4_QUIET_N closes in a row; null short of history. */
export const dfiiQuiet = (c: Pt[], r: Pick<Rules, "R4_DELTA_N" | "R4_D_MAX" | "R4_QUIET_N">): Run | null => {
  if (c.length < r.R4_DELTA_N + r.R4_QUIET_N) return null;
  const got = quietRun(c, r.R4_QUIET_N, (i) => ((d) => d !== null && d <= r.R4_D_MAX + EPS)(deltaAt(c, i, r.R4_DELTA_N)));
  return { text: `Δ${r.R4_DELTA_N} ${vs(delta(c, r.R4_DELTA_N), r.R4_D_MAX)[0]}≤${knob(r.R4_D_MAX)}`, got, need: r.R4_QUIET_N };
};
/** 10y z(Δ R2_DELTA_N over R2_Z_WINDOW) < R2_Z_MAX for R2_QUIET_N closes in a row; null short of history. */
export const tenYZ = (c: Pt[], r: Pick<Rules, "R2_DELTA_N" | "R2_Z_WINDOW" | "R2_Z_MAX" | "R2_QUIET_N">): Run | null => {
  const { z, got } = speedQuiet(c, { n: r.R2_DELTA_N, window: r.R2_Z_WINDOW, zMax: r.R2_Z_MAX, quiet: r.R2_QUIET_N });
  return z === null ? null : { text: zVs(z, r.R2_Z_MAX), got, need: r.R2_QUIET_N };
};
const RATES = fam("rates", "rates 10y RY · US 10y", { kind: "dash", id: "R4" }, [
  { tag: tag({ series: ["R4"], job: "speed", agg: "kOfN", variant: "absΔ63" }), rule: (r) => `10y RY Δ${r.R4_DELTA_N} ≤ +${knob(r.R4_D_MAX * 100)}bp ×${r.R4_QUIET_N}`, read: (r, x) => oneRun(dfiiQuiet(x.s.R4, r)) },
  { src: { kind: "dash", id: "R2" }, tag: tag({ series: ["R2"], job: "speed", agg: "kOfN" }), rule: (r) => `10y z(Δ${r.R2_DELTA_N}) < ${knob(r.R2_Z_MAX)} ×${r.R2_QUIET_N}`, read: (r, x) => oneRun(tenYZ(x.s.R2, r)) },
  {
    tag: tag({ series: ["R2", "R4"], job: "speed", agg: "kOfN", indicator: "10y RY · US 10y" }),
    rule: (r) => `10y z(Δ${r.R2_DELTA_N}) < ${knob(r.R2_Z_MAX)} ×${r.R2_QUIET_N} · 10y RY Δ${r.R4_DELTA_N} ≤ +${knob(r.R4_D_MAX * 100)}bp ×${r.R4_QUIET_N}`,
    read: (r, x) => ((z, d) => (z === null || d === null ? NA : allOf([partRun("10y", z), partRun("10y RY", d)])))(tenYZ(x.s.R2, r), dfiiQuiet(x.s.R4, r)),
  },
]);

/** RS_SMH > MA(n), optionally with Δ(n) > 0; `id` names the series in a mixed row; null short of history. */
const rsBits = (c: Pt[], n: number, mom: boolean, id: boolean): Bit[] | null => {
  const [m, d] = [ma(c, n), delta(c, n)];
  if (m === null || (mom && d === null)) return null;
  const [p, mp] = vs(last(c)!.value, m, 4);
  return [[`${id ? "RS_SMH " : ""}${p}>MA${n} ${mp}`, last(c)!.value! > m], ...(mom ? ([[`Δ${n} ${vs(d, 0, 4)[0]}>0`, d! > 0]] as Bit[]) : [])];
};
const CAPEX = fam("capex", "AI-capex SEC0 · HCX · RS_SMH", { kind: "dash", id: "LEGP_SEMIS" }, [
  {
    tag: tag({ series: ["LEGP_SEMIS"], job: "relative", agg: "kOfN" }),
    rule: (r) => `SEC0 off its shock-start high (no episode open: ${r.SEMIS_HIGH_N}-close high) > −${knob(r.SEMIS_OFF_MAX * 100)}%`,
    read: (r, x) => ((o) => (o ? { value: `${pctVs(o.dd, -r.SEMIS_OFF_MAX)[0]}/-${knob(r.SEMIS_OFF_MAX * 100)}%`, verdict: tick(o.dd > -r.SEMIS_OFF_MAX + EPS) } : NA))(shockOffHigh(x.s.LEGP_SEMIS) ?? offHigh(x.s.LEGP_SEMIS, r.SEMIS_HIGH_N)),
  },
  {
    src: { kind: "dash", id: "HCX" },
    tag: tag({ series: ["HCX", "RS_SMH"], job: "composite", agg: "kOfN", indicator: "HCX · RS_SMH" }),
    rule: (r) => `HCX state ≠ RED · RS_SMH > MA${r.RS_FAST_N}, Δ${r.RS_FAST_N} > 0`,
    read: (r, x) => {
      const st = last(x.s.HCX)?.state ?? null;
      const rs = rsBits(x.s.RS_SMH, r.RS_FAST_N, true, true);
      return st === null || rs === null ? NA : allOf([[`HCX ${st}`, st !== "RED"], ...rs]);
    },
  },
  { src: { kind: "dash", id: "RS_SMH" }, tag: tag({ series: ["RS_SMH"], job: "regime", agg: "kOfN" }), rule: (r) => `RS_SMH > MA${r.RS_SLOW_N}`, read: (r, x) => ((b) => (b === null ? NA : allOf(b)))(rsBits(x.s.RS_SMH, r.RS_SLOW_N, false, false)) },
]);
export const FAMS = { PRICE, VOL, CREDIT, RATES, CAPEX } as const;

const gateOf = (tranche: Tranche, name: string, leg: string, id: Id, t: ReadTag, rule: LegDef["rule"], read: LegDef["read"]): LegDef => ({ key: `${tranche.toLowerCase()}-${name}`, tranche, gate: true, leg, src: { kind: "dash", id }, tag: t, rule, read });
/** G1 deep-bear: holds while QDVE < G1_FRAC × its G1_HIGH_N-close high AND < MA(G1_MA_N); n/a short of G1_HIGH_N closes. */
const deepBear = (t: Tranche): LegDef =>
  gateOf(t, "g1", "gate: QDVE not deep bear", "LEGP_SPIT", tag({ series: ["LEGP_SPIT"], job: "composite", agg: "allOf" }), (r) => `not (< ${knob(r.G1_FRAC * 100)}% of ${r.G1_HIGH_N}-close high and < MA${r.G1_MA_N})`, (r, x) => {
    const c = x.s.LEGP_SPIT;
    const [o, m] = [c.length >= r.G1_HIGH_N ? offHigh(c, r.G1_HIGH_N) : null, ma(c, r.G1_MA_N)];
    if (o === null || m === null) return NA;
    const px = last(c)!.value!;
    const [deep, under] = [px < r.G1_FRAC * o.high, px < m];
    const w = dpCell([[px, r.G1_FRAC * o.high], [px, m]]);
    return { value: `${fix(px, w)} ${deep ? "<" : "≥"} ${fix(r.G1_FRAC * o.high, w)} (${fix(o.high)} ${mmdd(o.highDate)}) · ${under ? "<" : "≥"} MA${r.G1_MA_N} ${fix(m, w)}`, verdict: tick(!(deep && under)) };
  });
/** Value's veto (`noDrop`) on QDVE: each of the last VETO_N daily log returns ≥ −VETO_SD σ. */
const veto = (t: Tranche): LegDef =>
  gateOf(t, "veto", "veto: no QDVE crash day", "LEGP_SPIT", tag({ series: ["LEGP_SPIT"], job: "speed", agg: "allOf", variant: "σret" }), (r) => `QDVE ≥ −${r.VETO_SD}σ ×${r.VETO_N}`, (r, x) => {
    const p = noDrop(x.s.LEGP_SPIT, { ...VALUE_RULES, VETO_SD: r.VETO_SD, VETO_N: r.VETO_N, SIGMA_N: r.VETO_SIGMA_N });
    return p === null ? NA : { value: pctVs(p.ret, -p.cap).join("/"), verdict: tick(p.got >= r.VETO_N), count: { got: p.got, need: r.VETO_N } };
  });
/** The ruled box as a gate row of every tranche: unmet while `boxHolds`; `tally` holds the same guard; tag `series` = members' + box signs' ids (`BOX_SERIES`). */
const escLeg = (t: Tranche): LegDef =>
  gateOf(t, "esc", "gate: escalation box", "F1", tag({ series: BOX_SERIES, job: "composite", agg: "allOf", indicator: "escalation box" }), () => `holds on ≥ 1 coincident + ≥ 1 lead cluster vote, or a veto-row block (T1: ${Object.entries(VETO_MEASURED).map(([row, m]) => `${row} once ${m} trips`).join(", ")}) · T2·T3: live ≥ ⌈${knob(BOX_KERNEL.QUORUM_SHARE)}·n⌉`, (r, x) => ((e) => ({ value: clusterText(e), verdict: tick(!boxHolds(t, e)) }))(escalation(x, r)));
/** The ruled box in one cell: voting clusters · veto rows · live/n vs quorum. */
export const clusterText = (e: Escalation): string => `votes ${e.clusters.filter((c) => c.vote).map((c) => c.name).join(", ") || "—"}${e.veto.length ? ` · veto ${e.veto.join(", ")}` : ""} · live ${e.quorum.live}/${e.quorum.n} need ${e.quorum.need}`;

/** `tripped`/`hits` = the voting clusters, `need` = 2 (one coincident + one lead); `families` = the Episode gates display rows in `BOX_SIGNS` order (`familyRow`), each `live` repeating its close cell. */
export type Escalation = { tripped: number; need: number; hits: string[]; unread: string[]; families: LadderFamily[] } & Required<Pick<LadderVerdict["escalation"], "clusters" | "veto" | "quorum">> & { hold: boolean; holdT2T3: boolean };
/** Per-box-sign `trips when` text off the rules — never a typed value; a level prints through the same formatter as its cell. */
const BOX_RULE: Record<BoxSign, (r: Rules) => string> = {
  earnings: (r) => (r.HYBRID_GUARDS ? `RS_XLK < its since-shock ${HALF * 100}% line (no shock open: its ${r.ESC_RS_LOW_N}-close low)` : `RS_XLK < its ${r.ESC_RS_LOW_N}-close low`),
  yen: (r) => `USD/JPY ≤ −${knob(r.ESC_JPY_DROP * 100)}% off ${r.ESC_JPY_N}-close high`,
  policy: () => "sign block only",
};
/** Each box family's read tag (`familyRow`'s `opts.tag`); `policy` has no close read, so it carries the sign-only `manual` tag. */
const BOX_TAG: Record<BoxSign, ReadTag> = {
  earnings: tag({ series: ["RS_XLK"], job: "relative", agg: "box" }),
  yen: tag({ series: ["F17"], job: "relative", agg: "box" }),
  policy: { indicator: "policy", series: [], job: "manual", agg: "box" },
};
/** A blind close read's cell. */
const UNREAD: Reading = { value: "n/a", verdict: "na" };

/** The ruled box's member ids (`ruledCells`); RS_XLK (earnings) and yen are signs only — no member. */
export type MemberId = "real_yield" | "credit_confirms" | "hcx_red" | "vol_flip";
/** The ruled box roster (`boxOf`); never in `LADDER_LEGS` or the leg JSON. */
export const CLUSTERS = [
  { name: "rates-shock", kind: "lead", members: ["real_yield"] },
  { name: "credit", kind: "coincident", members: ["credit_confirms"] },
  { name: "cycle", kind: "lead", members: ["hcx_red"] },
  { name: "equity-vol", kind: "coincident", members: ["vol_flip"] },
] as const satisfies Roster<MemberId>;
export type Member = (typeof CLUSTERS)[number]["members"][number];
/** Core-driver BLOCK rows: one holds T2·T3 alone, every tranche once its `VETO_MEASURED` member trips (`reachOf`); every other row's block casts no vote. */
export const VETO_ROWS = ["hyper_capex", "it_revisions", "ai_funding", "semi_policy"] as const satisfies readonly SignId[];
/** Each veto row's measured half — the box member whose own close read (never OR'd with the row's block) grades its reach; unmapped → T2·T3. HCX is the
 *  hyperscaler-capex read; `ai_funding` (ORCL credit, AI loans) has no box series — HY OAS is not its measure — and `it_revisions` / `semi_policy` have no member. */
const VETO_MEASURED: Partial<Record<(typeof VETO_ROWS)[number], Member>> = { hyper_capex: "hcx_red" };
/** A member's cell + its Episode gates text: `rule` off the rules, `value` = the read the cell judged. */
export type MemberRead = { cell: Cell; rule: string; value: string };
const NO_HISTORY = "no history";
const hit = (ok: boolean): Cell => (ok ? "hit" : false);
/** Each member's ruled read, one series set per member so `readIds` records its own ids (`MEMBER_IDS`). */
/** Each read takes only the series and keys it reads, so another leg's rules/series fit. */
export const RULED = {
  real_yield: ({ s: { R4 } }: { s: { R4: Pt[] } }, r: Pick<Rules, "ESC_REAL_DELTA_N" | "ESC_REAL_DELTA">): MemberRead => {
    const d = delta(R4, r.ESC_REAL_DELTA_N);
    const bp = (v: number): string => vs(v * 100, r.ESC_REAL_DELTA * 100, 0).map((t, k) => `${[v, r.ESC_REAL_DELTA][k]! >= 0 ? "+" : ""}${t}bp`).join("/");
    return { cell: !R4.length ? "none" : d === null ? "na" : hit(d >= r.ESC_REAL_DELTA - EPS), rule: `10y RY Δ${r.ESC_REAL_DELTA_N} ≥ +${knob(r.ESC_REAL_DELTA * 100)}bp`, value: !R4.length ? NO_HISTORY : d === null ? shortOf(r.ESC_REAL_DELTA_N + 1) : bp(d) };
  },
  credit_confirms: ({ s: { F1 } }: { s: { F1: Pt[] } }, r: Parameters<typeof creditConfirms>[1]): MemberRead => creditConfirms(F1, r),
  hcx_red: ({ s: { HCX } }: { s: { HCX: Pt[] } }): MemberRead => ((st) => ({ cell: !HCX.length ? "none" : st === null ? "na" : hit(st === "RED"), rule: "HCX RED", value: !HCX.length ? NO_HISTORY : `HCX ${st ?? "state n/a"}` }))(last(HCX)?.state ?? null),
  vol_flip: ({ s: { VT } }: { s: { VT: Pt[] } }, r: Pick<Rules, "ESC_VOL_FLIP_N" | "ESC_VT">): MemberRead =>
    ((vt) => ({ cell: !VT.length ? "none" : vt === null ? "na" : hit(vt >= r.ESC_VOL_FLIP_N), rule: `VIX/VIX3M ≥ ${knob(r.ESC_VT)} ×${r.ESC_VOL_FLIP_N}`, value: !VT.length ? NO_HISTORY : vt === null ? shortOf(r.ESC_VOL_FLIP_N) : `VT ${vs(last(VT)!.value, r.ESC_VT)[0]} (≥${knob(r.ESC_VT)} ${vt}/${r.ESC_VOL_FLIP_N})` }))(
      VT.length < r.ESC_VOL_FLIP_N ? null : quietRun(VT, r.ESC_VOL_FLIP_N, (i) => VT[i]!.value! >= r.ESC_VT - EPS),
    ),
} satisfies { [M in Member]: (x: Inputs, r: Rules) => MemberRead };
const MEMBERS: readonly Member[] = CLUSTERS.flatMap((c) => c.members);
/** Each member's ruled read; `none` = its series has no point on or before the read date (every read site truncates to it). */
export const ruledReads = (x: Inputs, r: Rules): Record<Member, MemberRead> => Object.fromEntries(MEMBERS.map((m) => [m, RULED[m](x, r)])) as Record<Member, MemberRead>;
/** `ruledReads`' cells. */
export const ruledCells = (x: Inputs, r: Rules): Record<Member, Cell> => cellsOf(ruledReads(x, r));
/** The ruled box (`boxOf`) + the display rows, each a Kleene OR of a close read and a read mapped row's `block`; null = `unread`. */
export function escalation(x: Inputs, r: Rules): Escalation {
  const boxed = Object.values(BOX_ROWS).flat() as readonly string[];
  const stray = x.signs.find((g) => g.block && !boxed.includes(g.sign));
  if (stray) throw new Error(`probe:spit-tranches — sign "${stray.sign}" is ${(SIGNS as readonly string[]).includes(stray.sign) ? "context only" : "not a known sign id"}, so it cannot block`);
  const rowsOf = (b: BoxSign): LadderSign[] => x.signs.filter((g) => (BOX_ROWS[b] as readonly string[]).includes(g.sign) && isRead(g));
  const blockOf = (b: BoxSign): string | false | null => ((rows) => (rows.length ? (rows.find((g) => g.block)?.sign ?? false) : null))(rowsOf(b));
  const either = (b: BoxSign, hit: string | false | null): string | false | null => ((m) => hit || (m && `${b}: \`${m}\` blocks`) || (hit === false && m === false ? false : null))(blockOf(b));
  const { RS_XLK, F17 } = x.s;
  const xh = RS_XLK.length ? hybridLine(RS_XLK, RS_XLK.length - 1, "low", guardAnchor(RS_XLK, r.HYBRID_GUARDS)) : null;
  const xlk = xh?.line ?? (RS_XLK.length > r.ESC_RS_LOW_N ? Math.min(...vals(RS_XLK.slice(-r.ESC_RS_LOW_N - 1, -1))) : null);
  const earnings = xlk === null ? null : last(RS_XLK)!.value! < xlk && `earnings: RS_XLK ${fix(last(RS_XLK)!.value, 4)} < its ${xh ? "since-shock line" : `${r.ESC_RS_LOW_N}-close low`} ${fix(xlk, 4)}`;
  const jpy = offHigh(F17, r.ESC_JPY_N);
  const yen = jpy === null ? null : jpy.dd <= -r.ESC_JPY_DROP + EPS && `yen: USD/JPY ${pct(jpy.dd)} off its ${r.ESC_JPY_N}-close high`;
  /** The row's close cell off a close hit (`null` = blind → `UNREAD`); `value` is read only when the close exists. */
  const cellOf = (hit: string | false | null, value: () => string): Reading => (hit === null ? UNREAD : { value: value(), verdict: tick(!hit) });
  const rows: { name: BoxSign; close: string | false | null; cell: Reading | null }[] = [
    { name: "earnings", close: earnings, cell: cellOf(earnings, () => `RS_XLK ${fix(last(RS_XLK)!.value, 4)}/${fix(xlk, 4)}`) },
    { name: "yen", close: yen, cell: cellOf(yen, () => `JPY ${pct(jpy!.dd)}/${pct(-r.ESC_JPY_DROP)}`) },
    { name: "policy", close: false, cell: null },
  ];
  const all = rows.map((g) => ({ ...g, hit: either(g.name, g.close) }));
  /** An unread box sign names its unread rows: `earnings (it_revisions, aapl_demand)`. */
  const unreadOf = (b: BoxSign): string => ((ids) => (ids.length ? `${b} (${ids.join(", ")})` : b))(BOX_ROWS[b].filter((id) => !rowsOf(b).some((g) => g.sign === id)));
  const rowsNamed = (b: BoxSign | Member): LadderSign[] => BOX_ROWS[b].flatMap((id) => x.signs.filter((s) => s.sign === id));
  const families = all.map((g) => familyRow(g.name, BOX_RULE[g.name](r), g.cell, rowsNamed(g.name), { tag: BOX_TAG[g.name] }));
  const reads = ruledReads(x, r);
  const vetoes = VETO_ROWS.filter((id) => x.signs.some((g) => g.sign === id && g.block)).map((name) => ({ name, reach: reachOf(((m) => m !== undefined && reads[m].cell === "hit")(VETO_MEASURED[name]), LADDER_LEGS.spit.blockReach, x.signs.find((g) => g.sign === name)?.blocked?.reach) }));
  const box = boxOf(CLUSTERS, cellsOf(reads), vetoes);
  const signsOf = (id: Member) => rowsNamed(id).map(({ sign, lean, block }) => ({ sign, lean, block }));
  const clusters = box.clusters.map((c) => ({ ...c, members: c.members.map((m) => ((id) => ({ ...m, rule: reads[id].rule, value: reads[id].value, tag: MEMBER_TAG[id], ...((g) => (g.length ? { signs: g } : {}))(signsOf(id)) }))(m.id as Member)) }));
  return { tripped: box.votes.length, need: 2, hits: box.votes, unread: all.filter((g) => g.hit === null).map((g) => unreadOf(g.name)), families, clusters, veto: box.veto, quorum: { live: box.live, n: box.n, need: box.quorum, t1Only: box.t1Only }, hold: box.hold, holdT2T3: box.holdT2T3 };
}

export type { TrancheResult };
/** Need per tranche over N families: 1 / ⌈FAM_T2_SHARE·N⌉ / ⌈FAM_T3_SHARE·N⌉. */
export const famNeed = (t: Tranche, n: number, r: Rules = SPIT_RULES): number => famNeedOf(t, n, r);
/** Spit's need: `famNeed` of the voting families, floored at NEED_SLACK under the read voting criteria, so an unread feed lowers the need. */
const needOf = (r: Rules, families: number = VOTE_FAMILIES.length): NeedKnobs => ({ shares: r, families, slack: r.NEED_SLACK });
/** Ready = every gate met (credit's among them), the box not holding `t` (`boxHolds`), and `needOf`'s need met. */
export const tally = (t: Tranche, legs: readonly RawLeg[], r: Rules, esc: Escalation | null, families?: number): TrancheResult => tallyOf(t, legs, esc, needOf(r, families));
const legsAt = (x: Inputs, r: Rules, defs: readonly LegDef[] = LEGS): RawLeg[] => legsOf(x, r, defs);
export const tranchesAt = (x: Inputs, r: Rules): TrancheResult[] => tranchesOf(legsAt(x, r), escalation(x, r), needOf(r));

/** The ids `read` touches, recorded off a dry run over empty series. */
const readIds = (read: (x: Inputs) => unknown): Id[] => readIdsOf(read, { signs: [], exit: "" });
/** Each member's series, recorded off its own read (`RULED`). */
const MEMBER_IDS = Object.fromEntries(MEMBERS.map((m) => [m, readIds((y) => RULED[m](y, SPIT_RULES))])) as Record<Member, [Id, ...Id[]]>;
/** Each member's read tag (`escalation` copies it onto the member); `series` = `MEMBER_IDS`, never re-typed. */
const MEMBER_TAG: Record<Member, ReadTag> = {
  real_yield: tag({ series: MEMBER_IDS.real_yield, job: "speed", agg: "box", variant: `absΔ${SPIT_RULES.ESC_REAL_DELTA_N}` }),
  credit_confirms: tag({ series: MEMBER_IDS.credit_confirms, job: "regime", agg: "box" }),
  hcx_red: tag({ series: MEMBER_IDS.hcx_red, job: "level", agg: "box" }),
  vol_flip: tag({ series: MEMBER_IDS.vol_flip, job: "level", agg: "box" }),
};
const BOX_SERIES = [...new Set([...MEMBERS.flatMap((m) => MEMBER_IDS[m]), ...BOX_SIGNS.flatMap((b) => BOX_TAG[b].series as Id[])])] as [Id, ...Id[]];
/** The roster: per tranche the family rungs, then its gates; credit's rung is a gate at every tranche, so each counts the other four (`VOTE_FAMILIES`). */
export const LEGS: readonly LegDef[] = (["T1", "T2", "T3"] as const).flatMap((t, k): LegDef[] => [
  ...Object.values(FAMS).map((f) => (f === CREDIT ? asGate(CREDIT.rungs[k]!) : f.rungs[k]!)),
  deepBear(t),
  veto(t),
  escLeg(t),
]);
/** Every static read: the `LEGS` rows (key = row key) + the box families (key = family name) — `scripts/lint-ladder-reads.ts`'s input. */
export const TAGGED_READS: readonly TaggedRead[] = [...LEGS, ...BOX_SIGNS.map((b): TaggedRead => ({ key: b, tag: BOX_TAG[b] }))];
const eachId = (s: SeriesSet, f: (c: Pt[]) => Pt[]): SeriesSet => eachSeries(SERIES, s, f);
const liveSet = (s: SeriesSet): SeriesSet => eachId(s, livePrints);

/** The open `episodes` exit over QDVE closes (Value's `openExit`: a close ≤ (1 − DROP) × its running high, not yet at its episode end); undefined = none open. */
export const openExit = (c: SeriesSet): string | undefined => openExitOf(c.LEGP_SPIT);
export type { Follow };
/** Live anchors: the open exit, each tranche's first `firesAt` close after it, `n` = closes since; a `latched` fill on/after the exit stays as-is. */
export function followOf(c: SeriesSet, signs: readonly LadderSign[], r: Rules, latched: readonly (string | null)[] = [], events: readonly LadderEventDone[] = []): Follow | null {
  const exit = openExit(c);
  if (exit === undefined) return null;
  return walkFollow(exit, c.LEGP_SPIT.filter((p) => p.date > exit), latched, (d, fills) => firesAt({ s: eachId(c, upTo(d)), signs, exit }, r, fills, c.LEGP_SPIT, d, allFizzled(events, "T2", d)));
}
/** Which tranches fire at `d`: own legs ready, or clear and T1 TIME_STOP_N closes of `px` past `x.exit` / T2·T3 AFTER_N past the fill before; `fizzled` fires a clear T2 on T1's fill close. */
export function firesAt(x: Inputs, r: Rules, fills: readonly (string | null)[], px: Pt[], d: string, fizzled = false, defs: readonly LegDef[] = LEGS): boolean[] {
  return firesFrom(legsAt(x, r, defs), escalation(x, r), x, r, fills, px, d, fizzled);
}
/** `firesAt` off read legs; `esc` null = the box cleared (`tally`). */
function firesFrom(legs: readonly RawLeg[], esc: Escalation | null, x: Inputs, r: Rules, fills: readonly (string | null)[], px: Pt[], d: string, fizzled: boolean): boolean[] {
  const out = (["T1", "T2", "T3"] as const).map((t, k) => {
    const res = tally(t, legs, r, esc);
    if (res.ready) return true;
    if (!res.clear) return false;
    const since = k === 0 ? x.exit : fills[k - 1];
    return since !== null && since !== undefined && px.filter((p) => p.date > since && p.date <= d).length >= [r.TIME_STOP_N, r.T2_AFTER_N, r.T3_AFTER_N][k]!;
  });
  return fizzleFill(out, fills, d, fizzled, () => tally("T2", legs, r, esc).clear);
}
/** A binding close: some unfilled tranche the box holds fires with the box cleared — its gate row met, no hold. */
function binds(legs: readonly RawLeg[], esc: Escalation, x: Inputs, r: Rules, fills: readonly (string | null)[], px: Pt[], d: string): boolean {
  const open = firesFrom(legs.map((l) => (l.key === `${l.tranche.toLowerCase()}-esc` ? { ...l, verdict: "met" as const } : l)), null, x, r, fills, px, d, false);
  return (["T1", "T2", "T3"] as const).some((t, k) => fills[k] === null && boxHolds(t, esc) && open[k]);
}

/** A replayable form: the rules + the roster; `SHIPPED_FORM` = the live verdict's. */
export type Form = { r: Rules; defs: readonly LegDef[] };
export const SHIPPED_FORM: Form = { r: SPIT_RULES, defs: LEGS };
/** Value's `replayValue` over QDVE: per `episodes` exit (`end` = the shared episode end, `episodes`), every id cut PRE_DAYS before the shock through `end`, each tranche's first
 *  `firesAt` close after the exit with no sign rows (the time stop / after-T1 / after-T2 routes included); a third bought at each fill, marked at `end`; `binding` = its `binds` closes. */
export function replaySpit(s: SeriesSet, k: ReplayKnobs = REPLAY, form: Form = SHIPPED_FORM): (EpisodeResult & { binding: string[] })[] {
  const c = eachId(s, closes);
  return episodes(c.LEGP_SPIT, k).map((e) => {
    const cut = eachId(c, episodeWindow(e, k));
    const binding: string[] = [];
    const { fills } = walkFollow(e.exit, cut.LEGP_SPIT.filter((q) => q.date > e.exit), [], (d, now) => {
      const x: Inputs = { s: eachId(cut, upTo(d)), signs: [], exit: e.exit };
      const [legs, esc] = [legsAt(x, form.r, form.defs), escalation(x, form.r)];
      if (binds(legs, esc, x, form.r, now, cut.LEGP_SPIT, d)) binding.push(d);
      return firesFrom(legs, esc, x, form.r, now, cut.LEGP_SPIT, d, false);
    });
    return { ...scoreEpisode(c.LEGP_SPIT, e, fills), binding };
  });
}

const VIA: readonly Via[] = ["time stop", "after T1", "after T2"];
/** `--replay=why:<window>`: `whyFollow` over `replaySpit`, routed `count` (criteria met/need) or its follow `VIA` (`firesFrom`'s clear-and-elapsed route). */
export function whyFills(s: SeriesSet, k: ReplayKnobs = REPLAY, form: Form = SHIPPED_FORM): WhyRow[] {
  const c = eachId(s, closes);
  return whyFollow(replaySpit(s, k, form), (e) => episodeWindow(e, k)(c.LEGP_SPIT), (e, d, t) => {
    const x: Inputs = { s: eachId(eachId(c, episodeWindow(e, k)), upTo(d)), signs: [], exit: e.exit };
    const legs = legsAt(x, form.r, form.defs);
    return { legs, res: tally(t, legs, form.r, escalation(x, form.r)) };
  }, VIA, [form.r.TIME_STOP_N, form.r.T2_AFTER_N, form.r.T3_AFTER_N]);
}
/** `tranchesAt`, `met` = `firesAt` over `f` at the newest QDVE close; a follow-only fill names its `via`, a filled tranche carries its fill as `since`. */
export function followed(x: Inputs, r: Rules, f: Follow | null, events: readonly LadderEventDone[] = []): TrancheResult[] {
  const d = last(x.s.LEGP_SPIT)?.date;
  const fired = f && d ? firesAt({ ...x, exit: f.exit }, r, f.fills, x.s.LEGP_SPIT, d, allFizzled(events, "T2", d)) : null;
  return followedOf(tranchesAt(x, r), fired, f?.fills, d, (k) => VIA[k]!);
}
/** Whether tranche `t` is ready at QDVE close `d` with today's signs — `sinceOf`'s walk. */
const readyAt = (t: Tranche, x: Inputs, r: Rules) => (d: string): boolean => ((y: Inputs) => tally(t, legsAt(y, r), r, escalation(y, r)).ready)({ ...x, s: eachId(x.s, upTo(d)) });

/** The verdict ids — every `LEGS` row and the box. */
export const VERDICT_IDS: ReadonlySet<Id> = new Set(readIds((x) => tranchesAt(x, SPIT_RULES)));
export const verdictProvisional = (s: SeriesSet): boolean => provisionalOn(VERDICT_IDS, s);

/** Pure: closes give the verdict, latest prints the `live` column; `prior`'s `filledSince` are the latched fills, `events` feed the fizzle fast fill. */
export function evaluateShipped(s: SeriesSet, stored: readonly LadderSign[] = [], r: Rules = SPIT_RULES, prior?: LadderVerdict, events: readonly LadderEventDone[] = [], today?: string) {
  const signs = ((h) => (today ? reviewedSigns(h, events, today) : h))(heldSigns(stored, events)); // a released row holds nothing — a legacy block reads released when its escalation's `spares` names it; `today` = the read day a stale review demotes at
  const c = eachId(s, closes);
  const f = followOf(c, signs, r, prior?.tranches.map((t) => t.filledSince), events);
  const exit = f?.exit ?? openExit(c);
  const x: Inputs = { s: c, signs, ...(exit !== undefined && { exit }) };
  const live: Inputs = { ...x, s: liveSet(s) };
  const asOf = asOfOf(s, readIds((y) => tranchesAt(y, r)));
  const legs: LegResult[] = LEGS.map((d) => ({ key: d.key, tranche: d.tranche, leg: d.leg, rule: d.rule(r), ...(d.foot && { foot: d.foot(r) }), gate: d.gate ?? false, tag: d.tag, ...d.read(r, x), live: estTagged(d.read(r, live), s, readIds((y) => d.read(r, y)), asOf.live) }));
  const tranches = followed(x, r, f, events).map((t) => ({ ...t, since: t.ready && !t.fill ? sinceOf(x.s.LEGP_SPIT, readyAt(t.tranche, x, r)) : t.since }));
  return {
    legs,
    asOf,
    tranches,
    tranchesLive: followed(live, r, f, events),
    escalation: escalation(x, r),
    ...(f && { sessionsSinceExit: f.n }),
    regime: { set: "entry" },
  };
}
export type Res = ReturnType<typeof evaluateShipped>;
export const asProbeResult = (res: Res): LadderProbeResult => res;

const LIMIT = 400;
const DEEP_LIMIT = 4000;
/** At DEEP_LIMIT: QDVE so the `episodes` scan reaches its FROM; SEC0/RS_XLK (`episodes` anchors) and F1 (`shockOf`) so the anchor reads as replay's stored one. The 252-close high, MA200 and the 250-close z window fit LIMIT. */
const DEEP_IDS: readonly Id[] = ["LEGP_SPIT", "LEGP_SEMIS", "RS_XLK", "F1"];
export const liveLimit = (id: Id): number => (DEEP_IDS.includes(id) ? DEEP_LIMIT : LIMIT);
const fetchSeries = (base: string, id: Id): Promise<Pt[]> => fetchPoints(base, id, liveLimit(id));
const liveFetch = (base: string): Promise<SeriesSet> => fetchEach(SERIES, (id) => fetchSeries(base, id));

/** `spit:apply`'s re-probe: fetch once, then re-derive off the patched `signs` and the stored verdict's latched fills. */
export async function liveReverdict(base = prodBaseUrl()): Promise<(n: LadderLive) => LadderVerdict> {
  const s = await liveFetch(base);
  const prov = verdictProvisional(s);
  return (n) => toVerdict(evaluateShipped(s, n.signs, SPIT_RULES, n.verdict, allEvents(n), n.run), prov);
}

const MARK: Record<Verdict, string> = { met: "✓", unmet: "✗", na: "–" };
function table(res: Res): string {
  const out: string[] = [];
  for (const [i, t] of (["T1", "T2", "T3"] as const).entries()) {
    out.push(`── ${t} ${"─".repeat(74)}`);
    for (const l of res.legs.filter((x) => x.tranche === t)) out.push(`${l.leg} — ${l.rule}`, `  close  ${l.value}  ${MARK[l.verdict]}`, `  live   ${l.live.value}  ${MARK[l.live.verdict]}`);
    out.push("┄".repeat(80), `${t} total  close  ${probeTrancheCell(res.tranches[i]!)}`, `${"".padEnd(8)}  live   ${probeTrancheCell(res.tranchesLive[i]!)}`, "");
  }
  const e = res.escalation;
  out.push(
    `escalation box: ${boxStatus(e)} · ${clusterText(e)}${e.unread.length ? ` · unread: ${e.unread.join(", ")}` : ""}`,
    ...e.clusters.map((c) => `  ${c.name} (${c.kind}) ${c.hits}/${c.live} live of ${c.n}${c.vote ? " — votes" : ""} · ${c.members.map((m) => `${m.id} ${m.value ?? "—"}`).join(" · ")}`),
    `own legs and gates, or the follow path (time stop · after T1 · after T2)${res.sessionsSinceExit === undefined ? ", no QDVE drawdown open" : ` — ${res.sessionsSinceExit} closes since the QDVE drawdown opened`}; signs off ${LADDER_LEGS.spit.json}; live = latest print incl. the intraday head.`,
  );
  return out.join("\n");
}

/** `--replay=` (`replayScorecard`): the S&P IT scorecard; drift = the identity run (shipped = candidate = `SHIPPED_FORM`) — a job plan swaps the candidate. */
export const replaySpec: ReplaySpec<SeriesSet> = {
  fund: "LEGP_SPIT",
  px: "QDVE",
  ids: [...new Set<Id>(["LEGP_SPIT", ...VERDICT_IDS])],
  trim: (all, f) => eachId(all as SeriesSet, f),
  run: (s, k) => replaySpit(s, k, SHIPPED_FORM),
  why: (s, k) => whyFills(s, k),
  head: {
    verdict: "SPIT_RULES + LEGS · signs [] (manual rows have no history; the box reads off closes) · exit = `episodes` over QDVE, fill = each tranche's first `firesAt` close",
    drift: "shipped = candidate = SHIPPED_FORM (SPIT_RULES + LEGS) · Δ in QDVE closes",
    why: "SHIPPED_FORM · each fill's own rows at its fill close",
    p0: `SPIT_RULES + LEGS · binding days: a close the box holds that fires with the box cleared · esc = a later QDVE close ≤ ${BINDING.ESC_FRAC} × it by the episode end`,
  },
};

const isMain = process.argv[1]?.endsWith("probe-spit-tranches.ts") ?? false;
const replayArg = process.argv.find((a) => a.startsWith("--replay="))?.slice("--replay=".length);
if (isMain && replayArg !== undefined) await replayScorecard(process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl(), replayArg, replaySpec);
if (isMain && replayArg === undefined) {
  const base = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl();
  const into = process.argv.find((a) => a.startsWith("--into="))?.slice("--into=".length);
  const { existsSync, readFileSync } = await import("node:fs");
  const path = into ?? LADDER_LEGS.spit.json;
  const today = isoDay(new Date());
  const live: LadderLive = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LadderLive) : { run: today, rules: [], signs: [], events: [], calendar: [], runs: [] };
  const s = await liveFetch(base);
  const result = evaluateShipped(s, live.signs, SPIT_RULES, live.verdict, allEvents(live), today);
  if (into !== undefined) {
    const [{ gatesText }, { writeInto }] = await Promise.all([import("../src/ladder-live.js"), import("./ladder-into.js")]);
    const prov = verdictProvisional(s);
    const next = intoLive(live, toVerdict(result, prov));
    const md = writeInto(into, next, "spit");
    const tt = next.verdict!.tranches.map((t) => `${t.id} ${t.met}/${t.total}${gatesText(t.gates)}`).join(" ");
    console.log(`wrote ${into}${md ? ` + ${md}` : ""} · ${tt} · box ${clusterText(result.escalation)}${prov ? " · prov." : ""}`);
  } else if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(table(result));
}
