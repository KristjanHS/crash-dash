/**
 * Value (XDEV) entry ladder — three thirds, each on its own legs or the follow path, over prod `/api/series` plus the manual `signs[]` rows of
 * `public/value.json`; read-only report, `--into=` writes `verdict` only (+ re-renders `docs/value.md` on the canonical path, `ladder-into.ts`). `LEGS_SHIPPED` (the replay
 * baseline) = the Value entry-levels research's shipped rows less its HY level rows, its box row over the close-read families (`MEASURED`); the live `LEGS` = `LIVE_ARM`'s family roster (`famArm`).
 * Shares the verdict shape (`toVerdict`) with the EU-Fin probe.
 */
import { META } from "../src/api/http.js";
import { bindingOn, heldSigns, liftTaken, MEASURED_LIFT_CLOSES, measuredLift, reachOf, reviewedSigns } from "../src/ladder-block.js";
import type { Observation } from "../src/domain-types.js";
import { boxOf, kleeneAnd, type Cell, type Roster } from "../src/ladder-box.js";
import { RET_WINDOW, XDEV_GATE_DESCRIPTOR } from "../src/family-descriptor-rows.js";
import { KBE_WORST_DROP, VALUE_ESC_NEAR } from "../src/registry-price.js";
import { allEvents, displayText, dpCell, familyRow, fixNum, LEGS as LADDER_LEGS, makeTagOf, mmdd, pctVs, probeTrancheCell, rvApart, rvn, vc, vcAt, vs, zVs, toVerdict, type LadderEventDone, type LadderFamily, type LadderLive, type LadderMeasuredLift, type LadderProbeResult, type LadderSign, type LadderVerdict, type ReadTag, type TaggedRead, type TrancheId, type Via } from "../src/ladder-live.js";
import { delta, ma, newExtreme, noLowRun, offHigh, priorExt, quietRun, speedQuiet } from "../src/ladder-jobs.js";
import { allFizzled } from "../src/ladder-run.js";
import { asGate, CREDIT_FAM, creditConfirms, creditRungs } from "./ladder-credit.js";
import { DEEP_ROUTES, dropBadPrints } from "./ladder-replay-feeds.js";
import { acceptance, bindingTable, classifyBinding, driftTable, episodes, fillDrift, HOLDOUT_WINDOW, holdoutVerdict, parity, PASS, REPLAY, scoreEpisode, stopRow, sweepTable, whyTable, eachSeries, episodeWindow, fetchEach, knob, last, pct, upTo, vals, type EpisodeResult, type ReplayKnobs, type WhyRow } from "./ladder-replay.js";
import { asOfOf, both, closes, estTagged, isWeekend, livePrints, realizedVol, fetchPoints, TRANCHE_RULES as EUFIN_RULES, type Pt } from "./probe-eufin-tranches.js";
import { guardAnchor, guardRule, hybridBreak, hybridCut, openShockStart, shockOffHigh, VOL_COOL, VOL_K, volNormal, type ShockKnobs } from "./ladder-shock.js";
import { boxHolds, boxStatus, clearedBox, famNeedOf, fizzleFill, followedOf, legsOf, openExitOf, votesText, walkFollow, type Follow, provisionalOn, readIdsOf, tallyOf, tranchesOf, cellsOf, famRows, cmp, sinceOf, tick, type NeedKnobs, type RawLeg, type Reading, type TrancheResult, type Verdict } from "./ladder-tranche.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";
import { noFreeSource } from "../src/no-free-source.js";
import type { OcBar } from "../src/price-cache.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";
export { boxHolds } from "./ladder-tranche.js";
export type { Pt };

/** Every `[dash]` input — each must be a served `/api/series` id (`META`); anything else is a `[manual]` sign row. */
export const SERIES = ["XDEV", "LEGP_SEMIS", "F1", "F17", "MU_RS", "RS_SMH", "HCX", "R2", "KBE", "HYNIX", "AMAT", "F8", "KRW", "COPPER"] as const;
export type Id = (typeof SERIES)[number];
/** Plus the arm feeds (`ARM_SERIES`, the ▸ arms block): a live set holds `LIVE_FEEDS` only, a `--replay=` set all. */
export type SeriesSet = Record<Id, Pt[]> & Partial<Record<ArmId, Pt[]>>;
/** The arm feeds the live roster reads — closes-feed close ratios built per run by `liveFeeds`, not served ids; an unread one is [] and its gate holds. */
export const LIVE_FEEDS = ["RSP_SPY", "QQQE_QQQ"] as const;
/** The served arm ids the live set fetches off `/api/series` beside `SERIES` (R5 = VIXCLS for vol T3, R4 · KBE_RS for `ruledCells`) — each one a `VERDICT_IDS` id, since a 5xx on any aborts the run. */
export const LIVE_SERVED = ["R5", "R4", "KBE_RS"] as const satisfies readonly ArmId[];
export type LiveId = Id | (typeof LIVE_FEEDS)[number] | (typeof LIVE_SERVED)[number];
/** `liveFeeds`' symbol pairs: numerator ÷ denominator, the same pairs `deepSet` rebuilds. */
const LIVE_FEED_PAIRS: Record<(typeof LIVE_FEEDS)[number], readonly [string, string]> = { RSP_SPY: ["RSP", "SPY"], QQQE_QQQ: ["QQQE", "QQQ"] };
const unserved = SERIES.filter((id) => !META.has(id));
if (unserved.length) throw new Error(`probe:value-tranches — not served by /api/series: ${unserved.join(", ")}`);

/**
 * The `signs[].sign` ids the probe reads — each but `phl_orders` (context only; a `block: true` on it throws) shows on its box family row (`FAMILY_SIGN`); a `VETO_ROWS` block holds T2·T3
 * (every tranche once its `VETO_MEASURED` member trips), any other none (an escalated event's own hold is `afterHolds`). Banks, rates and credit also read served closes (`KBE` rebased to 100 —
 * relative reads only; `R2` = the DGS10 level).
 */
export const SIGNS = ["dram_contract", "hbm", "mu_strike", "kr_chip_ex", "capex", "ai_revenue", "jpy_carry", "credit", "rates", "phl_orders"] as const;
export type SignId = (typeof SIGNS)[number];

/** Every threshold lives here only (zones from the research doc §2; the rest §5.2 + its ruled line). Fractions are drawdowns off a high.
 *  The XDEV windows/zones/vol cuts read `XDEV_GATE_DESCRIPTOR` (their one source, shared with the XDEV chart overlays). */
const X = XDEV_GATE_DESCRIPTOR.scorer.constants;
export const VALUE_RULES = {
  /** The high the zone and the semis demotion read off, in closes. */
  HIGH_N: X.highWindow,
  /** Display only — XDEV close vs this MA, never a criterion. */
  MA_N: X.maWindow,
  /** First third opens at this drawdown and closes where the last third's zone starts. */
  ZONE_OPEN: X.zoneOpen,
  ZONE_T2: X.zoneT2,
  ZONE_T3: X.zoneT3,
  /** Each tranche needs all of its readable criteria less this many, floor 1 (gates are never criteria). */
  NEED_SLACK: 1,
  /** Semis (SEC0, the held fund) off its high — the one conditional that halves XDEV's recovery odds. Re-checked on SEC0: 0.10 holds. */
  SEMIS_OFF_HIGH_MAX: 0.1,
  /** Last third: close above its low over this many prior closes. */
  LOW_N: X.lowWindow,
  /** Episode gates family cuts (display rows, `FAMILY_RULE`); the pre-stack roster's T2/T3 criterion (`escLegShipped`, replay baseline only) needs no close-read family tripped. */
  ESC_KBE_DROP: KBE_WORST_DROP.drop,
  ESC_KBE_N: KBE_WORST_DROP.window,
  ESC_JPY_DROP: 0.08,
  ESC_JPY_N: 15,
  ESC_DGS10: 5.35,
  /** Footer near-miss: an untripped measured family that has covered ≥ 1 − ESC_NEAR of the way to its trigger — a level from its HIGH_N-close low, a drawdown from 0 — or a level within ESC_NEAR_GAP of it. */
  ESC_NEAR: VALUE_ESC_NEAR,
  ESC_NEAR_GAP: 0.02,
  /** The box's member cuts (`ruledCells`): HY ≥ ESC_HY_MA_K × MA(ESC_SPREAD_MA_N) · KBE_RS Δ%(ESC_KBE_RS_N) ≤ −ESC_KBE_RS_DROP ·
   *  10y Δ(ESC_RATES_DELTA_N) ≥ ESC_DGS10_DELTA ∧ DFII10 Δ ≥ ESC_REAL_DELTA. */
  ESC_SPREAD_MA_N: 200,
  ESC_HY_MA_K: 1.1,
  ESC_KBE_RS_N: 21,
  ESC_KBE_RS_DROP: 0.1,
  ESC_RATES_DELTA_N: 21,
  ESC_DGS10_DELTA: 0.5,
  ESC_REAL_DELTA: 0.4,
  /** Veto (first and second thirds): every one of the last VETO_N daily returns of XDEV ≥ −VETO_SD × σ (σ = sd of the SIGMA_N log returns before them), of MU (`F8`) > −MU_VETO_CAP. */
  VETO_SD: X.vetoSd,
  MU_VETO_CAP: X.muVetoCap,
  VETO_N: X.vetoWindow,
  SIGMA_N: X.sigmaWindow,
  /** Credit gate at every tranche (`creditRungs`, `ladder-credit.ts`; Semis's values): HY back T1/T2/T3_RETRACE of its own shock's peak → base, T2's peak ≥ T2_PEAK_AGE_N closes old.
   *  HY's shock reads BASE_N · BROKE_SD here and SIGMA_N above — one knob with the veto's σ window. */
  BASE_N: 20,
  BROKE_SD: 3,
  T1_RETRACE: 1 / 3,
  T2_RETRACE: 1 / 2,
  T2_PEAK_AGE_N: 10,
  T3_RETRACE: 2 / 3,
  /** HY guard: HY OAS made no new GUARD_HIGH_N-close high in the latest N closes (`HYBRID_GUARDS` → no close past its since-shock line while HY's shock is open) — never shorter in a later tranche. */
  GUARD_HIGH_N: 20,
  T1_HY_GUARD_N: 5,
  T2_HY_GUARD_N: 10,
  T3_HY_GUARD_N: 10,
  /** Realized vol (XDEV), anchored per `volOf` (the open episode's `shockStart`, else the `HIGH_N`-close high): the first third's = RV(RV_N) ≥ RV_OFF_PEAK under its peak since the anchor and under RV(RV_N) RV_LAG closes back —
   *  or the second third's level test, so the first third never trails it. */
  RV_N: X.rvWindow,
  RV_SLOW_N: X.rvSlowWindow,
  RV_OFF_PEAK: X.rvOffPeak,
  RV_LAG: 5,
  /** The second third's: RV(RV_N) ≤ T2_RV_MULT × the RV(SIGMA_N) ending at the anchor; the last's: RV(RV_SLOW_N) ≤ T3_RV_MULT × it. */
  T2_RV_MULT: X.t2RvMult,
  T3_RV_MULT: X.t3RvMult,
  /** Hybrid guards: the HY / R2 no-high and MU_RS no-low guards break on `hybridBreak` while their own shock is open; false = rolling only. */
  HYBRID_GUARDS: true,
} as const;
export type Rules = { [K in keyof typeof VALUE_RULES]: (typeof VALUE_RULES)[K] extends string ? string : (typeof VALUE_RULES)[K] extends boolean ? boolean : number };

export type Tranche = TrancheId;
export type { Verdict };
/** `exit` = the episode exit a family arm's post-shock reads anchor on (`firesAt`), absent → n/a; `lifted` = the measured-lifted `VETO_ROWS` (`measuredLifts`). */
export type Inputs = { s: SeriesSet; signs: readonly LadderSign[]; exit?: string; lifted?: readonly string[] };
/** `tip` = the expected cell's what + why (`VerdictLeg.tip`), for a `rule` too long to say it. */
export type LegDef = { key: string; tranche: Tranche; gate?: boolean; leg: string; src: { kind: "dash"; id: Id | ArmId }; rule: (r: Rules) => string; tip?: (r: Rules) => string; read: (r: Rules, x: Inputs) => Reading; tag: ReadTag };
export type LegResult = Reading & { key: string; tranche: Tranche; leg: string; rule: string; tip?: string; gate: boolean; live: Reading; tag: ReadTag };
/** Series id → the leg's one canonical read name (`ReadTag.indicator`); a multi-series row names its own. */
export const INDICATOR: Record<Id | ArmId, string> = { XDEV: "XDEV", LEGP_SEMIS: "SEC0", F1: "HY OAS", F17: "USD/JPY", MU_RS: "MU_RS", RS_SMH: "RS_SMH", HCX: "HCX", R2: "10y", KBE: "KBE", HYNIX: "Hynix", AMAT: "AMAT", F8: "MU", KRW: "KRW", COPPER: "copper", R4: "10y RY", R5: "VIX", KBE_RS: "KBE/SPY", RSP_SPY: "RSP/SPY", QQQE_QQQ: "QQQE/QQQ", MU_OPEN: "MU open", MU_CLOSE: "MU close" };
/** A row's `ReadTag` off its call site — the shared builder (`makeTagOf`, src/ladder-live.ts): `indicator` derives from `INDICATOR` for a single series; a multi-series row names it (throws at load otherwise). */
const tagOf = makeTagOf(INDICATOR);

const NA: Reading = { value: "—", verdict: "na" };
/** Float slack on a drawdown compared with a zone constant, so a close exactly at the level sits inside. */
const EPS = 1e-9;

/** Worst peak-to-trough inside the last `n` closes: the deepest close off the running high before it, with that trough's date. */
export function worstDrop(c: Pt[], n: number): { dd: number; troughDate: string } | null {
  const w = c.slice(-n);
  if (!w.length) return null;
  let hi = -Infinity;
  let worst = { dd: 0, troughDate: w.at(-1)!.date };
  for (const p of w) {
    hi = Math.max(hi, p.value!);
    if (p.value! / hi - 1 < worst.dd) worst = { dd: p.value! / hi - 1, troughDate: p.date };
  }
  return worst;
}

/** First date of the trailing run of closes sitting at or under `ZONE_OPEN` off their trailing high — the zone's open. */
export function zoneSince(c: Pt[], r: Rules): string | null {
  let since: string | null = null;
  for (let i = c.length; i > 0; i--) {
    const o = offHigh(c.slice(0, i), r.HIGH_N);
    if (!o || o.dd > -r.ZONE_OPEN) break;
    since = c[i - 1]!.date;
  }
  return since;
}


/**
 * The comparator reads the table PRINTS under the tranches (by ruling): Hynix vs Micron off
 * their own `HIGH_N`-close highs (the earlier high broke first) and `AMAT:MU` vs the ratio's `MA_N` MA; plus `KRW`/`COPPER`'s
 * `HIGH_N`-close change. Never a criterion, gate or box input — no `LEGS` row reads
 * `HYNIX`, `AMAT`, `KRW` or `COPPER` (`F8` feeds the veto too). `F8`'s served value IS the Micron close (a CONTEXT row, never
 * rebased); the other four arrive rebased to 100, so only drawdowns, ratios and changes are read off them.
 */
export type CompareRead = { hynix: ReturnType<typeof offHigh>; mu: ReturnType<typeof offHigh>; first: "HYNIX" | "MU" | "same day" | null; amatMu: { vsMa: number } | null; krw: number | null; copper: number | null };
/** Last close over the close `n` back, less 1; null short of `n + 1` closes. */
const changeOver = (c: Pt[], n: number): number | null => (c.length > n ? c.at(-1)!.value! / c.at(-1 - n)!.value! - 1 : null);
export function compareReads(c: SeriesSet, r: Rules): CompareRead {
  const hynix = offHigh(c.HYNIX, r.HIGH_N);
  const mu = offHigh(c.F8, r.HIGH_N);
  const first = !hynix || !mu ? null : hynix.highDate < mu.highDate ? "HYNIX" : mu.highDate < hynix.highDate ? "MU" : "same day";
  const muByDate = new Map(c.F8.map((p) => [p.date, p.value!]));
  const ratio: Pt[] = c.AMAT.flatMap((p) => (muByDate.has(p.date) ? [{ date: p.date, value: p.value! / muByDate.get(p.date)! }] : []));
  const m = ma(ratio, r.MA_N);
  const lastRatio = last(ratio)?.value ?? null;
  return { hynix, mu, first, amatMu: m === null || lastRatio === null ? null : { vsMa: lastRatio / m - 1 }, krw: changeOver(c.KRW, r.HIGH_N), copper: changeOver(c.COPPER, r.HIGH_N) };
}
const offText = (o: ReturnType<typeof offHigh>): string => (o ? `${pct(o.dd)} off ${o.highDate.slice(5)} high` : "—");
/** The printed form of `compareReads`; every line carries the never-a-gate tag. The AMAT:MU ratio's LEVEL is never printed —
 *  rebased AMAT over a raw Micron close is an arbitrary number; only its distance from its own MA means anything. */
export const compareText = (k: CompareRead, r: Rules): string[] => [
  `Hynix ${offText(k.hynix)} · MU ${offText(k.mu)}${k.first ? ` — ${k.first === "same day" ? "highs on the same day" : `${k.first === "HYNIX" ? "Hynix" : "MU"} broke its high first`}` : ""} (${r.HIGH_N}-close highs) — display only, never a gate`,
  `AMAT:MU ${k.amatMu ? `${pct(k.amatMu.vsMa)} vs its MA${r.MA_N}` : "—"} — display only, never a gate`,
  `USD/KRW ${k.krw === null ? "—" : pct(k.krw)} over ${r.HIGH_N} closes — display only, never a gate`,
  `Copper ${k.copper === null ? "—" : pct(k.copper)} over ${r.HIGH_N} closes — display only, never a gate`,
];

/** Zone gate: XDEV's drawdown off its `HIGH_N` high at or past `lo`, and short of `hi` when given. */
function zone(c: Pt[], r: Rules, lo: number, hi?: number): Reading {
  const o = offHigh(c, r.HIGH_N);
  if (!o) return NA;
  return { value: `XDEV ${pct(o.dd)}/-${knob(lo * 100)}${hi === undefined ? "" : `…-${knob(hi * 100)}`}%`, verdict: tick(o.dd <= -lo + EPS && (hi === undefined || o.dd > -hi + EPS)) };
}
const zoneLeg = (lo: (r: Rules) => number, hi?: (r: Rules) => number): Pick<LegDef, "rule" | "tip" | "read"> => ({
  rule: (r) => `${hi ? "" : "≤ "}−${knob(lo(r) * 100)}${hi ? `…−${knob(hi(r) * 100)}` : ""}% off ${r.HIGH_N}-close high`,
  tip: (r) => `XDEV's latest close vs its highest of the last ${r.HIGH_N} closes — the dip zone this third buys in: at least ${knob(lo(r) * 100)}% down${hi ? `, short of the ${knob(hi(r) * 100)}% where the last third's zone starts` : ""}.`,
  read: (r, x) => zone(x.s.XDEV, r, lo(r), hi?.(r)),
});

const sd =(a: number[]): number => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const ret = (c: Pt[], i: number): number => Math.log(c[i]!.value! / c[i - 1]!.value!);

/** One veto series: the run of its last `VETO_N` returns clearing −`VETO_SD`σ, or a `fixed` simple-return cap; null short of `SIGMA_N + VETO_N + 1` closes (`VETO_N + 1` when fixed). */
export function noDrop(c: Pt[], r: Rules, fixed?: number): { got: number; ret: number; cap: number; shown: number } | null {
  // `ret`/`shown` print in the cap's own terms: log on the σ path, simple on the fixed one
  if (c.length < (fixed === undefined ? r.SIGMA_N : 0) + r.VETO_N + 1) return null;
  const end = c.length - r.VETO_N;
  const cap = fixed === undefined ? r.VETO_SD * sd(Array.from({ length: r.SIGMA_N }, (_, k) => ret(c, end - 1 - k))) : -Math.log(1 - fixed);
  const last = ret(c, c.length - 1);
  return { got: quietRun(c, r.VETO_N, (i) => (fixed === undefined ? ret(c, i) >= -cap : ret(c, i) > -cap)), ret: fixed === undefined ? last : Math.exp(last) - 1, cap, shown: fixed ?? cap };
}
const veto = (tranche: Tranche, tag: ReadTag): LegDef => ({
  key: `${tranche.toLowerCase()}-veto`,
  tranche,
  gate: true,
  tag,
  leg: "veto: no XDEV/MU crash day",
  src: { kind: "dash", id: "XDEV" },
  rule: (r) => `XDEV ≥ −${r.VETO_SD}σ · MU > −${knob(r.MU_VETO_CAP * 100)}% ×${r.VETO_N}`,
  tip: (r) => `Each of the last ${r.VETO_N} daily returns: XDEV no worse than −${r.VETO_SD}σ (σ = sd of the ${r.SIGMA_N} daily log returns before them), Micron no worse than −${knob(r.MU_VETO_CAP * 100)}%. One crash day in the window holds the third.`,
  read: (r, x) => {
    const parts = ([["XDEV", x.s.XDEV], ["MU", x.s.F8]] as const).map(([id, c]) => [id, noDrop(c, r, id === "MU" ? r.MU_VETO_CAP : undefined)] as const);
    const live = parts.flatMap(([, p]) => (p ? [p] : []));
    if (!live.length) return NA;
    const got = Math.min(...live.map((p) => p.got));
    return { value: parts.map(([id, p]) => `${id} ${p ? (id === "MU" ? `${pctVs(p.ret, -p.shown)[0]}/-${knob(p.shown * 100)}%` : pctVs(p.ret, -p.shown).join("/")) : "n/a"}`).join(" · "), verdict: tick(got >= r.VETO_N), count: { got, need: r.VETO_N } };
  },
});
/** Value-only, a gate beside the shared credit gate (`ladder-credit.ts`) at every tranche: it holds the T1 fill the ⅓ gate lets through before a second HY spike.
 *  Anchors on the same HY shock the credit gate reads (`VALUE_RULES` BASE_N · SIGMA_N · BROKE_SD). */
const hyGuard = (tranche: Tranche, n: (r: Rules) => number, tag: ReadTag): LegDef => ({
  key: `${tranche.toLowerCase()}-hy-guard`,
  tranche,
  gate: true,
  tag,
  leg: "guard: HY OAS no new high",
  src: { kind: "dash", id: "F1" },
  rule: (r) => guardRule("high", r.GUARD_HIGH_N, n(r), r.HYBRID_GUARDS),
  read: (r, x) => {
    const c = x.s.F1;
    if (c.length < r.GUARD_HIGH_N + n(r)) return NA;
    const at = guardAnchor(c, r.HYBRID_GUARDS, { BASE_N: r.BASE_N, SIGMA_N: r.SIGMA_N, BROKE_SD: r.BROKE_SD });
    const got = quietRun(c, n(r), (i) => !(hybridBreak(c, i, "high", at) ?? newExtreme(c, i, r.GUARD_HIGH_N, "high", { guard: false })));
    return { value: vcAt(last(c)!.value, hybridCut(c, "high", at) ?? priorExt(c, r.GUARD_HIGH_N, "high")), verdict: tick(got >= n(r)), count: { got, need: n(r) } };
  },
});

/** XDEV RV(`RV_N`) now, its peak (+ date) since the anchor, and the baseline RV(`SIGMA_N`) ending at it; null short of history.
 *  Anchor (`openShockStart`): the open XDEV episode's `shockStart`, else the `HIGH_N`-close high. */
export type Vol = { c: Pt[]; i: number; now: number; peak: number; peakDate: string; base: number | null };
export function volOf(c: Pt[], r: Rules): Vol | null {
  const o = offHigh(c, r.HIGH_N);
  const i = c.length - 1;
  const now = realizedVol(c, i, r.RV_N);
  if (!o || now === null) return null;
  const first = c.findIndex((p) => p.date === (openShockStart(c) ?? o.highDate));
  const m = rvMax(c, first, i, r.RV_N);
  const [peak, peakDate] = m.max > now ? [m.max, c[m.at]!.date] : [now, c[i]!.date];
  return { c, i, now, peak, peakDate, base: realizedVol(c, first, r.SIGMA_N) };
}
/** Per scan start close + n: the last scan's array and reach, so a longer prefix of the same closes scans only its new ones (live follow / replay walk a close at a time). */
/** `read` = a copy of the closes c[first − n, hi) the scan read — a copy, so an array changed in place after it never matches. */
type RvScan = { read: Pt[]; first: number; hi: number; max: number; at: number };
const RV_SCANS = new WeakMap<Pt, Map<number, RvScan>>();
/** max over k ∈ [first, hi) of RV(n) at k (null → 0), `at` = its earliest k (−1 when empty); reuses a scan whose closes c[first − n, its hi) are the same objects. */
export function rvMax(c: Pt[], first: number, hi: number, n: number): { max: number; at: number } {
  const [key, lo] = [c[first], Math.max(0, first - n)];
  const byN = (key && RV_SCANS.get(key)) || new Map<number, RvScan>();
  const prev = byN.get(n);
  const reuse = prev !== undefined && prev.first === first && prev.hi <= hi && prev.read.every((p, j) => p === c[lo + j]);
  let [max, at] = reuse ? [prev.max, prev.at] : [-Infinity, -1];
  for (let k = reuse ? prev.hi : first; k < hi; k++) {
    const x = realizedVol(c, k, n) ?? 0;
    if (x > max) [max, at] = [x, k];
  }
  if (key) RV_SCANS.set(key, byN.set(n, { read: c.slice(lo, hi), first, hi, max, at }));
  return { max, at };
}
const VOL ={ leg: "vol XDEV realized", src: { kind: "dash", id: "XDEV" } } as const;
const volRolled: Pick<LegDef, "rule" | "tip" | "read"> = {
  rule: (r) => `RV${r.RV_N} cooling | ≤ ${r.T2_RV_MULT}× base`,
  tip: (r) => `XDEV realized vol over ${r.RV_N} closes: at most ${knob(1 - r.RV_OFF_PEAK)}× its peak since the open XDEV episode's shock start (none open: the ${r.HIGH_N}-close high) and below its value ${r.RV_LAG} closes back (cooling) — or at most ${r.T2_RV_MULT}× the base, the RV${r.SIGMA_N} ending at that start, so this third never trails the second.`,
  read: (r, x) => {
    const v = volOf(x.s.XDEV, r);
    if (v === null) return NA;
    const lag = realizedVol(v.c, v.i - r.RV_LAG, r.RV_N);
    const [offPeak, base] = [(1 - r.RV_OFF_PEAK) * v.peak, v.base === null ? null : r.T2_RV_MULT * v.base];
    const ok = [v.now <= offPeak, lag !== null && v.now < lag, base !== null && v.now <= base] as const;
    const w = rvApart(v.now, [offPeak, lag, base]);
    const value = `${rvn(v.now, w)} ${cmp("≤", `${rvn(offPeak, w)} (${rvn(v.peak)} ${mmdd(v.peakDate)})`, ok[0])} ${cmp("<", `${rvn(lag, w)}${lag === null ? "" : ` (${mmdd(v.c[v.i - r.RV_LAG]!.date)})`}`, ok[1])} | ${cmp("≤", rvn(base, w), ok[2])}`;
    return { value, verdict: tick(ok[2] || (ok[0] && ok[1])) };
  },
};
const volVsBase = (n: (r: Rules) => number, mult: (r: Rules) => number): Pick<LegDef, "rule" | "tip" | "read"> => ({
  rule: (r) => `RV${n(r)} ≤ ${mult(r)}× base`,
  tip: (r) => `XDEV realized vol over the last ${n(r)} closes vs the base: the RV${r.SIGMA_N} ending at the open XDEV episode's shock start (none open: the ${r.HIGH_N}-close high), the calm before the dip. Back under ${mult(r)}× it = the storm has passed.`,
  read: (r, x) => {
    const v = volOf(x.s.XDEV, r);
    const now = v && realizedVol(v.c, v.i, n(r));
    if (!v || now === null) return NA;
    const cut = v.base === null ? null : mult(r) * v.base;
    const w = rvApart(now, [cut]);
    const value = `${rvn(now, w)}/${rvn(cut, w)}`;
    return v.base === null ? { ...NA, value } : { value, verdict: tick(now <= mult(r) * v.base) };
  },
});

/** `tripped`/`hits` = the voting clusters (`boxOf`), `need` = one vote per `Kind`; `families` = the Episode gates display rows in `FAMILIES` order (`familyRow`). */
export type Escalation = { tripped: number; need: number; hits: string[]; unread: string[]; near: string[]; families: LadderFamily[] } & Required<Pick<LadderVerdict["escalation"], "clusters" | "veto" | "quorum">> & { hold: boolean; holdT2T3: boolean };
/** The pre-stack close rows (`familyReads`): `escLegShipped`'s criterion and the near-miss reads. */
const CLOSE_ROWS = ["Micron", "banks", "yen", "rates", "capex"] as const;
type CloseRow = (typeof CLOSE_ROWS)[number];
/** The Episode gates display rows — a close row duplicating a `CLUSTERS` member is that member (`MEMBER_OF`), never a family. */
export const FAMILIES = ["Micron", "yen", "capex"] as const satisfies readonly CloseRow[];
type Family = (typeof FAMILIES)[number];
/** The member each dropped close row duplicates: its signs (`FAMILY_SIGN`) and its near-miss ride that member. */
const MEMBER_OF = { banks: "kbe_rs_drop", rates: "rates_jump" } as const satisfies Record<Exclude<CloseRow, Family>, BoxMember>;
/** Every sign row but `phl_orders` feeds one box row; Micron and capex read their signs alone. */
const FAMILY_SIGN: Partial<Record<Family | BoxMember, readonly SignId[]>> = { Micron: ["dram_contract", "hbm", "mu_strike", "kr_chip_ex"], credit_confirms: ["credit"], yen: ["jpy_carry"], rates_jump: ["rates"], kbe_rs_drop: [], capex: ["capex", "ai_revenue"] };
const signsKey = (f: CloseRow): Family | BoxMember => (f in MEMBER_OF ? MEMBER_OF[f as keyof typeof MEMBER_OF] : (f as Family));
const SIGN_ONLY: readonly CloseRow[] = ["Micron", "capex"];
/** The series each close row's read touches — the live cell's `est.` tag reads their heads; pinned against `familyReads`' own reads in the probe test. */
export const FAMILY_IDS: Record<CloseRow, readonly LiveId[]> = { Micron: [], banks: ["KBE"], yen: ["F17"], rates: ["R2"], capex: [] };
/** An `unread` family named with what it lacks. */
const unreadWhy = (f: string): string => `${f} (${SIGN_ONLY.includes(f as CloseRow) ? "no sign row" : f in FAMILY_SIGN ? "no sign row, no close" : "no close"})`;

/** A family's read as the share of the way from `base` to `trigger` it has covered (≥ 1 = at or past it). */
type Near = { text: string; p: number };
const near = (text: string, v: number, base: number, trigger: number): Near | null => (trigger === base ? null : { text, p: (v - base) / (trigger - base) });
/** A level's read: `near` floored by its gap to `trigger` — 1 − ESC_NEAR at ESC_NEAR_GAP off it, 1 at it. */
const nearLevel = (text: string, v: number, base: number, trigger: number, r: Rules): Near => ({ text, p: Math.max(near(text, v, base, trigger)?.p ?? 0, 1 - (r.ESC_NEAR * (trigger - v)) / (trigger * r.ESC_NEAR_GAP)) });
const lowOf = (c: Pt[], n: number): number => Math.min(...vals(c.slice(-n)));

/** The box's level knobs as the family cells print them — the rule text reads the same formatter, so a retune renders identically in both. */
const LVL = { DGS10: (r: Rules): string => r.ESC_DGS10.toFixed(2) } as const;
/** Per-family `trips when` text off the rules — never a typed value. */
const FAMILY_RULE: Record<Family, (r: Rules) => string> = {
  Micron: () => "sign block only",
  yen: (r) => `USD/JPY ≤ −${knob(r.ESC_JPY_DROP * 100)}% off ${r.ESC_JPY_N}-close high`,
  capex: () => "sign block only",
};
/** A blind close read's cell. */
const UNREAD: Reading = { value: "n/a", verdict: "na" };
/** Each box family's read tag (`familyRow` copies it onto the row); `Micron` and `capex` are sign-only. */
export const FAMILY_TAG: Record<Family, ReadTag> = {
  Micron: { indicator: "Micron", series: [], job: "manual", agg: "box" },
  yen: tagOf({ series: ["F17"], job: "relative", agg: "box" }),
  capex: { indicator: "capex", series: [], job: "manual", agg: "box" },
};
/** The close rows' ids, as `escLegShipped` reads them. */
const CLOSE_SERIES = CLOSE_ROWS.flatMap((f) => FAMILY_IDS[f]) as (Id | ArmId)[];

type BoxMember = "credit_confirms" | "kbe_rs_drop" | "rates_jump";
/** The ruled box roster (`boxOf`); Micron · yen · capex · growth rows are signs, no vote. */
export const CLUSTERS = [
  { name: "credit", kind: "coincident", members: ["credit_confirms"] },
  { name: "bank-funding", kind: "coincident", members: ["kbe_rs_drop"] },
  { name: "rates-shock", kind: "lead", members: ["rates_jump"] },
] as const satisfies Roster<BoxMember>;
export type Member = (typeof CLUSTERS)[number]["members"][number];
/** Core-driver BLOCK rows: one not measured-lifted (`Inputs.lifted`) holds T2·T3 alone, every tranche once its `VETO_MEASURED` member trips (`reachOf`); every other row's block casts no vote. */
export const VETO_ROWS = ["credit", "rates"] as const satisfies readonly SignId[];
/** Each veto row's measured half — the box member whose own close read (never OR'd with the row's block) grades its reach; unmapped → T2·T3. */
const VETO_MEASURED: Partial<Record<(typeof VETO_ROWS)[number], Member>> = { credit: "credit_confirms", rates: "rates_jump" };
/** A member's ruled cell, its `trips when` text off the rules and the read it judged (the verdict's `ClusterView` member). */
export type MemberRead = { cell: Cell; rule: string; value: string };
const bp = (d: number): string => `${d >= 0 ? "+" : ""}${Math.round(d * 100)}bp`;
type Part = { cell: Cell; text: string };
const part = (name: string, c: Pt[], need: number, read: () => readonly [boolean, string]): Part =>
  !c.length ? { cell: "none", text: `${name} no history` } : c.length < need ? { cell: "na", text: `${name} short of ${need} closes` } : ((ok, t) => ({ cell: ok ? "hit" : false, text: `${name} ${t}` }))(...read());
const and2 = (rule: string, a: Part, b: Part): MemberRead => ({ cell: kleeneAnd(a.cell, b.cell), rule, value: `${a.text} · ${b.text}` });
const one = (rule: string, a: Part): MemberRead => ({ cell: a.cell, rule, value: a.text });
const deltaPart = (name: string, c: Pt[], n: number, cut: number): Part => part(name, c, n + 1, () => ((d) => [d >= cut - EPS, bp(d)] as const)(last(c)!.value! - c.at(-1 - n)!.value!));
/** Each member's ruled read, one series set per member so `readIds` records its own ids (`MEMBER_IDS`). */
const RULED: { [M in Member]: (x: Inputs, r: Rules) => MemberRead } = {
  credit_confirms: ({ s: { F1 } }, r) => creditConfirms(F1, r),
  kbe_rs_drop: ({ s: { KBE_RS = [] } }, r) =>
    one(
      `KBE/SPY ≤ −${knob(r.ESC_KBE_RS_DROP * 100)}% over ${r.ESC_KBE_RS_N} closes`,
      part("KBE/SPY", KBE_RS, r.ESC_KBE_RS_N + 1, () => ((d) => [d <= -r.ESC_KBE_RS_DROP + EPS, `${pct(d)}/${pct(-r.ESC_KBE_RS_DROP)}`] as const)(last(KBE_RS)!.value! / KBE_RS.at(-1 - r.ESC_KBE_RS_N)!.value! - 1)),
    ),
  rates_jump: ({ s: { R2, R4 = [] } }, r) => and2(`10y ≥ +${knob(r.ESC_DGS10_DELTA * 100)}bp ∧ 10y RY ≥ +${knob(r.ESC_REAL_DELTA * 100)}bp over ${r.ESC_RATES_DELTA_N} closes`, deltaPart("10y", R2, r.ESC_RATES_DELTA_N, r.ESC_DGS10_DELTA), deltaPart("10y RY", R4, r.ESC_RATES_DELTA_N, r.ESC_REAL_DELTA)),
};
const MEMBERS: readonly Member[] = CLUSTERS.flatMap((c) => c.members);
/** Each member's read; `none` = its series has no point on or before the read date (every read site truncates to it), `na` = short of the closes it needs. */
export const memberReads = (x: Inputs, r: Rules): Record<Member, MemberRead> => Object.fromEntries(MEMBERS.map((m) => [m, RULED[m](x, r)])) as Record<Member, MemberRead>;
/** Each member's ruled cell (`memberReads` projected). */
export const ruledCells = (x: Inputs, r: Rules): Record<Member, Cell> => cellsOf(memberReads(x, r));

/** The close rows (`CLOSE_ROWS`) — a close read where `[dash]`, the sign row's `block` where manual (Micron, capex), yen and rates either; a row with neither is `unread`, never tripped. */
export function familyReads(x: Inputs, r: Rules) {
  const familyless = x.signs.find((g) => g.block && !Object.values(FAMILY_SIGN).some((ids) => ids.includes(g.sign as SignId)));
  if (familyless) throw new Error(`probe:value-tranches — sign "${familyless.sign}" feeds no box family, so it cannot block`);
  /** The family's first blocking sign; `false` when its rows read clear, `null` when it has none. */
  const blockOf = (f: CloseRow): SignId | false | null =>
    ((rows) => (rows.length ? ((rows.find((g) => g.block)?.sign as SignId | undefined) ?? false) : null))(x.signs.filter((g) => (FAMILY_SIGN[signsKey(f)] ?? []).includes(g.sign as SignId)));
  /** A family read off a close AND its sign rows: the close's hit, else a row's block; `null` only when both are. */
  const either = (f: CloseRow, closeHit: string | false | null): string | false | null =>
    ((b) => closeHit || (b && `${f}: \`${b}\` blocks`) || (closeHit === null && b === null ? null : false))(blockOf(f));
  const jpy = offHigh(x.s.F17, r.ESC_JPY_N);
  const kbe = worstDrop(x.s.KBE, r.ESC_KBE_N);
  const dgs10 = last(x.s.R2)?.value ?? null;
  const jpyHit = jpy === null ? null : jpy.dd <= -r.ESC_JPY_DROP + EPS && `yen: USD/JPY ${pct(jpy.dd)} off its ${r.ESC_JPY_N}-close high`;
  const ratesHit = dgs10 === null ? null : dgs10 >= r.ESC_DGS10 && `rates: 10y ${dgs10.toFixed(2)}% ≥ ${r.ESC_DGS10}%`;
  const banksHit = kbe === null ? null : kbe.dd <= -r.ESC_KBE_DROP + EPS && `banks: KBE ${pct(kbe.dd)} peak-to-trough (${kbe.troughDate.slice(5)}) inside ${r.ESC_KBE_N} closes`;
  /** The row's close cell off a close hit (`null` = blind → `UNREAD`); `value` is read only when the close exists. */
  const cellOf = (hit: string | false | null, value: () => string): Reading => (hit === null ? UNREAD : { value: value(), verdict: tick(!hit) });
  const fams: { name: CloseRow; hit: string | false | null; cell: Reading | null }[] = [
    { name: "Micron", hit: either("Micron", null), cell: null },
    { name: "banks", hit: banksHit, cell: cellOf(banksHit, () => `KBE ${pct(kbe!.dd)}/${pct(-r.ESC_KBE_DROP)}`) },
    { name: "yen", hit: either("yen", jpyHit), cell: cellOf(jpyHit, () => `JPY ${pct(jpy!.dd)}/${pct(-r.ESC_JPY_DROP)}`) },
    { name: "rates", hit: either("rates", ratesHit), cell: cellOf(ratesHit, () => `10y ${dgs10!.toFixed(2)}/${LVL.DGS10(r)}`) },
    { name: "capex", hit: either("capex", null), cell: null },
  ];
  const reads: Partial<Record<CloseRow, (Near | null)[]>> = {
    banks: [kbe && near(`banks KBE ${pct(kbe.dd)}/${pct(-r.ESC_KBE_DROP)}`, kbe.dd, 0, -r.ESC_KBE_DROP)],
    yen: [jpy && near(`yen ${pct(jpy.dd)}/${pct(-r.ESC_JPY_DROP)}`, jpy.dd, 0, -r.ESC_JPY_DROP)],
    rates: [dgs10 === null ? null : nearLevel(`rates ${dgs10.toFixed(2)}/${r.ESC_DGS10.toFixed(2)}`, dgs10, lowOf(x.s.R2, r.HIGH_N), r.ESC_DGS10, r)],
  };
  const nearMiss = fams
    .filter((f) => f.hit === false)
    .flatMap((f) => ((ns) => (ns.length ? [{ name: f.name, ...ns.reduce((a, b) => (b.p > a.p ? b : a)) }] : []))((reads[f.name] ?? []).filter((n): n is Near => n !== null && n.p >= 1 - r.ESC_NEAR - EPS)))
    .sort((a, b) => b.p - a.p);
  return { fams, nearMiss };
}
/** The box (`boxOf` over `CLUSTERS` · `VETO_ROWS`) + its family display rows; `live` = the latest-print pass: each family row's `live` cell re-reads them, `est.`-tagged off `s` (`FAMILY_IDS`) as the leg rows are. */
export function escalation(x: Inputs, r: Rules, live?: { x: Inputs; s: Record<LiveId, Pt[]>; at: string }): Escalation {
  const { fams: rows, nearMiss } = familyReads(x, r);
  const fams = rows.filter((f): f is (typeof rows)[number] & { name: Family } => (FAMILIES as readonly string[]).includes(f.name));
  const liveEsc = live && escalation(live.x, r);
  const rowsNamed = (k: Family | BoxMember): LadderSign[] => (FAMILY_SIGN[k] ?? []).flatMap((id) => x.signs.filter((g) => g.sign === id));
  const nearOf = (k: Family | BoxMember): boolean => nearMiss.some((n) => signsKey(n.name) === k);
  const families = fams.map((f, i) =>
    familyRow(f.name, FAMILY_RULE[f.name](r), f.cell, rowsNamed(f.name), {
      near: nearOf(f.name),
      live: live && f.cell ? estTagged(liveEsc!.families[i]!, live.s, FAMILY_IDS[f.name], live.at) : null,
      tag: FAMILY_TAG[f.name],
    }),
  );
  const reads = memberReads(x, r);
  const vetoes = VETO_ROWS.filter((id) => x.signs.some((g) => g.sign === id && g.block) && !x.lifted?.includes(id)).map((name) => ({ name, reach: reachOf(((m) => m !== undefined && reads[m].cell === "hit")(VETO_MEASURED[name]), LADDER_LEGS.value.blockReach, x.signs.find((g) => g.sign === name)?.blocked?.reach) }));
  const box = boxOf(CLUSTERS, cellsOf(reads), vetoes);
  const liveOf = (id: Member) => ((m) => m?.value && { live: estTagged({ value: m.value }, live!.s, MEMBER_IDS[id], live!.at).value, liveCell: m.cell })(liveEsc?.clusters.flatMap((c) => c.members).find((m) => m.id === id));
  const clusters = box.clusters.map((c) => ({ ...c, members: c.members.map((m) => ((id) => ({ ...m, rule: reads[id].rule, value: reads[id].value, tag: MEMBER_TAG[id], ...((g) => (g.length ? { signs: g.map(({ sign, lean, block }) => ({ sign, lean, block })) } : {}))(rowsNamed(id)), ...(nearOf(id) && { near: true }), ...liveOf(id) }))(m.id as Member)) }));
  return { tripped: box.votes.length, need: new Set(CLUSTERS.map((c) => c.kind)).size, hits: box.votes, unread: fams.filter((f) => f.hit === null).map((f) => f.name), near: nearMiss.map((n) => n.text), families, clusters, veto: box.veto, quorum: { live: box.live, n: box.n, need: box.quorum, t1Only: box.t1Only }, hold: box.hold, holdT2T3: box.holdT2T3 };
}

/** The box as a gate row of every tranche (`famArm`): met while `boxHolds` is false; `tally` holds the same guard. One rule text for all three (the quorum clause is prefixed `T2·T3:`), so the row renders once under shared gates until the readings differ. */
const escLeg = (key: string, tranche: Tranche, tag: ReadTag): LegDef => ({
  key,
  tranche,
  gate: true,
  tag,
  leg: "gate: escalation box",
  src: { kind: "dash", id: "F1" },
  rule: () => `no coincident + lead vote · no ${VETO_ROWS.join("/")} veto (T1: ${Object.entries(VETO_MEASURED).map(([row, m]) => `${row} once ${m} trips`).join(", ")}) · T2·T3: live ≥ quorum`,
  tip: () =>
    `The episode box: ${CLUSTERS.map((c) => `${c.name} (${c.kind})`).join(", ")} each vote on a majority of their live members. A coincident and a lead vote together, or a ${VETO_ROWS.join(" or ")} sign row's block once its own measured member trips, hold every third; that block alone holds the second and last thirds; under quorum (too few members readable) the second and last thirds hold too.`,
  read: (r, x) => ((e) => ({ value: votesText(e), verdict: tick(!boxHolds(tranche, e)) }))(escalation(x, r)),
});

/** The close-read rows: every close row but the sign-only ones. */
const MEASURED = CLOSE_ROWS.filter((f) => !SIGN_ONLY.includes(f));
/** The pre-stack transcription's box criterion (`LEGS_SHIPPED` only — the replay `baseline`): a non-gate T2/T3 row met while no close-read family
 *  tripped on its close (a manual block never counts); `na` when every close read is blind. The live roster reads `escLeg`. */
const escLegShipped = (key: string, tranche: Tranche, tag: ReadTag): LegDef => ({
  key,
  tranche,
  tag,
  leg: "escalation box",
  src: { kind: "dash", id: "F1" },
  rule: () => `0/${MEASURED.length} families tripped`,
  tip: () => `The escalation box's ${MEASURED.length} close-read families (${MEASURED.join(", ")}): none tripped on its close read.`,
  read: (r, x) =>
    ((fams) => {
      const close = fams.filter((f) => MEASURED.includes(f.name) && typeof f.hit === "string" && !f.hit.endsWith("` blocks")).map((f) => f.name);
      const blind = fams.filter((f) => MEASURED.includes(f.name) && f.cell === UNREAD).map((f) => f.name);
      return { value: `${close.length}/${MEASURED.length}${close.length ? ` (${close.join(", ")})` : ""}${blind.length ? ` · no close ${blind.join(", ")}` : ""}`, verdict: blind.length === MEASURED.length ? "na" : tick(close.length === 0) };
    })(familyReads(x, r).fams),
});

/** The pre-stack roster: the replay `baseline` arm and the base every arm swaps into; the live verdict reads `LEGS`. */
export const LEGS_SHIPPED: readonly LegDef[] = [
  { key: "t1-zone", tranche: "T1", gate: true, leg: "gate: XDEV zone", src: { kind: "dash", id: "XDEV" }, tag: tagOf({ series: ["XDEV"], job: "relative", agg: "allOf" }), ...zoneLeg((r) => r.ZONE_OPEN, (r) => r.ZONE_T3) },
  {
    key: "t1-smh",
    tranche: "T1",
    leg: "semis SEC0",
    tag: tagOf({ series: ["LEGP_SEMIS"], job: "relative", agg: "kOfN" }),
    // Reads `LEGP_SEMIS`: SEC0's EUR close (SMH ÷ EURUSD chain-joined before 2021-08-06); off-high is scale-invariant, FX is not.
    src: { kind: "dash", id: "LEGP_SEMIS" },
    rule: (r) => `SEC0 off high > −${knob(r.SEMIS_OFF_HIGH_MAX * 100)}%`,
    tip: (r) => `SEC0 (the held semis fund) latest close vs its close at the open SEC0 episode's shock start (none open: its highest of the last ${r.HIGH_N} closes). Semis ${knob(r.SEMIS_OFF_HIGH_MAX * 100)}%+ off their high is the one condition that halves XDEV's recovery odds.`,
    read: (r, x) => ((o) => (o ? { value: `${pctVs(o.dd, -r.SEMIS_OFF_HIGH_MAX)[0]}/-${knob(r.SEMIS_OFF_HIGH_MAX * 100)}%`, verdict: tick(o.dd > -r.SEMIS_OFF_HIGH_MAX + EPS) } : NA))(shockOffHigh(x.s.LEGP_SEMIS) ?? offHigh(x.s.LEGP_SEMIS, r.HIGH_N)),
  },
  { key: "t1-vol", tranche: "T1", ...VOL, ...volRolled, tag: tagOf({ series: ["XDEV"], job: "composite", agg: "kOfN", indicator: "XDEV" }) },
  veto("T1", tagOf({ series: ["XDEV", "F8"], job: "speed", agg: "allOf", indicator: "XDEV · MU", variant: "σret" })),
  hyGuard("T1", (r) => r.T1_HY_GUARD_N, tagOf({ series: ["F1"], job: "relative", agg: "allOf" })),
  { key: "t2-zone", tranche: "T2", gate: true, leg: "gate: XDEV zone", src: { kind: "dash", id: "XDEV" }, tag: tagOf({ series: ["XDEV"], job: "relative", agg: "allOf" }), ...zoneLeg((r) => r.ZONE_T2) },
  escLegShipped("t2-esc", "T2", tagOf({ series: CLOSE_SERIES, job: "composite", agg: "kOfN", indicator: "escalation box" })),
  {
    key: "t2-kbe",
    tranche: "T2",
    leg: "banks KBE drawdown",
    tag: tagOf({ series: ["KBE"], job: "relative", agg: "kOfN", variant: "worstDrop" }),
    src: { kind: "dash", id: "KBE" },
    rule: (r) => `KBE ${r.ESC_KBE_N}-close drop > −${knob(r.ESC_KBE_DROP * 100)}%`,
    tip: (r) => `Regional banks (KBE): the deepest close off its running high inside the last ${r.ESC_KBE_N} closes. A ${knob(r.ESC_KBE_DROP * 100)}% slide, even one that bounced, means bank stress is live — the same read trips the banks family.`,
    read: (r, x) => ((o) => (o ? { value: `KBE ${pct(o.dd)}/-${knob(r.ESC_KBE_DROP * 100)}%`, verdict: tick(o.dd > -r.ESC_KBE_DROP + EPS) } : NA))(worstDrop(x.s.KBE, r.ESC_KBE_N)),
  },
  {
    key: "t2-rs",
    tranche: "T2",
    leg: "semis rel-strength",
    tag: tagOf({ series: ["MU_RS", "RS_SMH"], job: "level", agg: "kOfN", indicator: "MU_RS · RS_SMH" }),
    src: { kind: "dash", id: "MU_RS" },
    rule: () => "not both RED",
    tip: () => "Registry states of MU_RS (Micron vs semis) and RS_SMH (semis vs SPY); the third holds only when both read RED.",
    read: (_r, x) => {
      const a = last(x.s.MU_RS)?.state ?? null;
      const b = last(x.s.RS_SMH)?.state ?? null;
      return a === null || b === null ? NA : { value: `MU_RS ${a} · RS_SMH ${b}`, verdict: tick(!(a === "RED" && b === "RED")) };
    },
  },
  { key: "t2-vol", tranche: "T2", ...VOL, ...volVsBase((r) => r.RV_N, (r) => r.T2_RV_MULT), tag: tagOf({ series: ["XDEV"], job: "recovery", agg: "kOfN" }) },
  veto("T2", tagOf({ series: ["XDEV", "F8"], job: "speed", agg: "allOf", indicator: "XDEV · MU", variant: "σret" })),
  hyGuard("T2", (r) => r.T2_HY_GUARD_N, tagOf({ series: ["F1"], job: "relative", agg: "allOf" })),
  { key: "t3-zone", tranche: "T3", gate: true, leg: "gate: XDEV zone", src: { kind: "dash", id: "XDEV" }, tag: tagOf({ series: ["XDEV"], job: "relative", agg: "allOf" }), ...zoneLeg((r) => r.ZONE_T3) },
  escLegShipped("t3-esc", "T3", tagOf({ series: CLOSE_SERIES, job: "composite", agg: "kOfN", indicator: "escalation box" })),
  {
    key: "t3-low",
    tranche: "T3",
    leg: "XDEV price shape",
    tag: tagOf({ series: ["XDEV"], job: "relative", agg: "kOfN", variant: "aboveLow" }),
    src: { kind: "dash", id: "XDEV" },
    rule: (r) => `close > min(prior ${r.LOW_N})`,
    read: (r, x) => {
      const c = x.s.XDEV;
      if (c.length < r.LOW_N + 1) return NA;
      const low = Math.min(...vals(c.slice(-r.LOW_N - 1, -1)));
      return { value: `${last(c)!.value!.toFixed(2)}/${low.toFixed(2)}`, verdict: tick(last(c)!.value! > low) };
    },
  },
  { key: "t3-vol", tranche: "T3", ...VOL, ...volVsBase((r) => r.RV_SLOW_N, (r) => r.T3_RV_MULT), tag: tagOf({ series: ["XDEV"], job: "recovery", agg: "kOfN" }) },
  hyGuard("T3", (r) => r.T3_HY_GUARD_N, tagOf({ series: ["F1"], job: "relative", agg: "allOf" })),
];

export type { TrancheResult };

/** `VALUE_ARM`'s family shares, held here so `needOf` reads no later binding. */
const FAM_SHARES = { FAM_T2_SHARE: 0.4, FAM_T3_SHARE: 0.6 } as const;
/** Value's need: all its readable criteria less `NEED_SLACK` — capped at `famNeed` (`VALUE_ARM` shares) on a family arm (`families` set). */
const needOf = (r: Rules, families?: number): NeedKnobs => ({ shares: FAM_SHARES, families, slack: r.NEED_SLACK });
/** One tranche's own legs only: ready = its gates (zone, veto, guards) met, the box not holding it (`boxHolds`), and `needOf`'s need met. No other tranche is read. */
export const tally = (t: Tranche, legs: readonly RawLeg[], r: Rules, esc: Escalation, families?: number): TrancheResult => tallyOf(t, legs, esc, needOf(r, families));

const legsAt = (x: Inputs, r: Rules, defs: readonly LegDef[] = LEGS): RawLeg[] => legsOf(x, r, defs);
export const tranchesAt = (x: Inputs, r: Rules, defs: readonly LegDef[] = LEGS, families?: number): TrancheResult[] => tranchesOf(legsAt(x, r, defs), escalation(x, r), needOf(r, families));

/** The ids `read` touches, recorded off a dry run over empty series. */
const readIds = (read: (x: Inputs) => unknown): LiveId[] => readIdsOf(read, { signs: [] });
/** The series each member reads, recorded off its own read (`RULED`) — its `live` text's `est.` tag reads their heads. */
const MEMBER_IDS = Object.fromEntries(MEMBERS.map((m) => [m, readIds((y) => RULED[m](y, VALUE_RULES))])) as Record<Member, LiveId[]>;
/** The live box's ids, as `escLeg` reads them: the close rows (`familyReads`) + every member's. */
const BOX_SERIES = [...new Set([...CLOSE_SERIES, ...MEMBERS.flatMap((m) => MEMBER_IDS[m])])] as (Id | ArmId)[];
/** Each member's read tag (`escalation` copies it onto the member); `series` = `MEMBER_IDS`, never re-typed. */
const MEMBER_TAG: Record<Member, ReadTag> = {
  credit_confirms: tagOf({ series: MEMBER_IDS.credit_confirms, job: "regime", agg: "box" }),
  kbe_rs_drop: tagOf({ series: MEMBER_IDS.kbe_rs_drop, job: "speed", agg: "box", variant: `pctΔ${VALUE_RULES.ESC_KBE_RS_N}` }),
  rates_jump: tagOf({ series: MEMBER_IDS.rates_jump, job: "speed", agg: "box", indicator: "10y · 10y RY", variant: `absΔ${VALUE_RULES.ESC_RATES_DELTA_N}` }),
};
/** The verdict's `prov.` flag: a provisional head on an id the verdict reads — a settled-elsewhere display-only row (a KRX close
 *  read under the US-time cutoff) never flips it. */
export const verdictProvisional = (s: SeriesSet): boolean => provisionalOn(VERDICT_IDS, s);

/** Per-id over the ids `s` holds (a live set = SERIES; a `--replay=` set adds ARM_SERIES). */
const eachId = (s: SeriesSet, f: (c: Pt[]) => Pt[]): SeriesSet => eachSeries(Object.keys(s), s, f);
const liveSet = (s: SeriesSet): SeriesSet => Object.fromEntries([...SERIES, ...LIVE_FEEDS, ...LIVE_SERVED].map((id) => [id, livePrints(s[id] ?? [])])) as SeriesSet;
/** `s` with every `LIVE_FEEDS`/`LIVE_SERVED` id present ([] when absent), so each read id has a series. */
const withFeeds = (s: SeriesSet): SeriesSet & Record<LiveId, Pt[]> => ({ ...(Object.fromEntries([...LIVE_FEEDS, ...LIVE_SERVED].map((id): [string, Pt[]] => [id, []])) as Record<Exclude<LiveId, Id>, Pt[]>), ...s });
/** Whether tranche `t` is ready at XDEV close `d`, with today's sign rows and `x.exit` — `sinceOf`'s walk, read only outside an open follow episode. */
const readyAt = (t: Tranche, x: Inputs, r: Rules, arm: ValueArm) => (d: string): boolean => ((y: Inputs) => tally(t, legsAt(y, r, arm.defs), r, escalation(y, r), arm.families).ready)({ ...x, s: eachId(x.s, upTo(d)) });

/** Pure: closes give the verdict, the latest prints (`livePrints`) the `live` column; both read the open exit (`openExit`) as `Inputs.exit`, `lifts` (`measuredLifts`, echoed as the verdict's) as `Inputs.lifted`; `display` = the MA read that is never a criterion (`displayText`).
 *  `arm` = the roster (default `LIVE_ARM`); a `follow` arm's open exit adds the follow path (`followOf`), its count in `sessionsSinceExit`.
 *  `prior` = the stored verdict this run replaces: its `filledSince` dates are the follow path's latched fills (`followOf`); `events` = the live state's events, read by the follow path's fizzle fast fill (`allFizzled`). */
export function evaluateShipped(s0: SeriesSet, stored: readonly LadderSign[] = [], r: Rules = VALUE_RULES, arm: ValueArm = LIVE_ARM, prior?: LadderVerdict, events: readonly LadderEventDone[] = [], today?: string, lifts: readonly LadderMeasuredLift[] = []) {
  const signs = ((h) => (today ? reviewedSigns(h, events, today) : h))(heldSigns(stored, events)); // a released row holds nothing — a legacy block reads released when its escalation's `spares` names it; `today` = the read day a stale review demotes at
  const s = withFeeds(s0);
  const c = eachId(s, closes);
  const exit = openExit(c);
  const x: Inputs = { s: c, signs, ...(exit !== undefined && { exit }), ...(lifts.length && { lifted: lifts.map((l) => l.sign) }) };
  const live: Inputs = { ...x, s: liveSet(s) };
  const asOf = asOfOf(s, [...readIds((y) => tranchesAt(y, r, arm.defs))]);
  const legs: LegResult[] = arm.defs.map((d) => ({ key: d.key, tranche: d.tranche, leg: d.leg, rule: d.rule(r), ...(d.tip && { tip: d.tip(r) }), gate: d.gate ?? false, ...d.read(r, x), live: estTagged(d.read(r, live), s, readIds((y) => d.read(r, y)), asOf.live), tag: d.tag }));
  const f = followOf(arm, c, signs, r, prior?.tranches.map((t) => t.filledSince), events);
  const tranches = followed(arm, x, r, f, events).map((t) => ({ ...t, since: t.ready && !t.fill ? sinceOf(x.s.XDEV, readyAt(t.tranche, x, r, arm)) : t.since }));
  const m = ma(c.XDEV, r.MA_N);
  const xdev = last(c.XDEV)?.value ?? null;
  return {
    legs,
    asOf,
    tranches,
    tranchesLive: followed(arm, live, r, f, events),
    escalation: escalation(x, r, { x: live, s, at: asOf.live }),
    ...(f && { sessionsSinceExit: f.n }),
    ...(lifts.length && { lifts: [...lifts] }),
    regime: { set: "entry" },
    display: { maN: r.MA_N, vsMa: m === null || xdev === null ? null : xdev / m - 1, zoneSince: zoneSince(c.XDEV, r) },
  };
}
export type Res = ReturnType<typeof evaluateShipped>;
/** The shared verdict contract: `toVerdict` takes `Res` as it is. */
export const asProbeResult = (res: Res): LadderProbeResult => res;

const LIMIT = 400;
/** `--replay=`'s stored read (EU-Fin's sweep limit). */
const DEEP_LIMIT = 4000;
/** Snapshot-fed ids: a build that does not serve one yet reads empty (`na`); any other id's 400 throws. None today. */
const FORWARD_ONLY: readonly Id[] = [];
export const unservedReadsEmpty = (id: Id, status: number, body: string): boolean => FORWARD_ONLY.includes(id) && status === 400 && body.includes("id must be one of");

const fetchSeries = (base: string, id: Id | ArmId, limit = LIMIT): Promise<Pt[]> => fetchPoints(base, id, limit, (status, body) => unservedReadsEmpty(id as Id, status, body));

const MARK: Record<Verdict, string> = { met: "✓", unmet: "✗", na: "–" };

/** Each `LEGS.value.measuredLifts` binding of a held sign (`heldSigns`), its series off `read` (FRED): a `measuredLift` the row takes (`liftTaken`, apply's guard) → `lifts`; else the veto kept, a `notes` line. */
export async function measuredLifts(signs: readonly LadderSign[], read: (series: string) => Promise<readonly Observation[]>): Promise<{ lifts: LadderMeasuredLift[]; notes: string[] }> {
  const [lifts, notes]: [LadderMeasuredLift[], string[]] = [[], []];
  for (const [sign, b] of Object.entries(LADDER_LEGS.value.measuredLifts)) {
    const g = signs.find((x) => x.sign === sign && x.block);
    if (!g) continue;
    if (!bindingOn(b, g.measurable)) {
      notes.push(`measured lift off: ${sign} — clause drift`);
      continue;
    }
    const got = await read(b.series).then((c) => ({ c }), (e: Error) => ({ c: [] as Observation[], err: e.message }));
    const p = measuredLift(b, got.c);
    const l = p && { sign, series: b.series, value: p.value, date: p.date, since: p.since };
    const taken = !!l && liftTaken(g, l, b);
    if (taken) lifts.push(l);
    notes.push(taken ? `measured lift: ${sign} — ${b.series} ${l.value} (${l.date.slice(5)}) < ${b.below}` : `measured lift held: ${sign} — ${"err" in got ? `${b.series} unread — ${got.err}` : p ? `${b.series} closes since ${p.since.slice(5)} predate the block (${g.blocked?.on.slice(5)})` : `${b.series} last ${MEASURED_LIFT_CLOSES} closes not all < ${b.below}`}`);
  }
  return { lifts, notes };
}

/** One section per tranche: each leg a `leg — rule` line over a close row and a live row; the box, the display read and the manual roster under. */
function table(res: Res, s: SeriesSet, r: Rules = VALUE_RULES): string {
  const out: string[] = [];
  for (const [i, t] of (["T1", "T2", "T3"] as const).entries()) {
    out.push(`── ${t} ${"─".repeat(74)}`);
    for (const l of res.legs.filter((x) => x.tranche === t)) out.push(`${l.leg} — ${l.rule}`, `  close  ${l.value}  ${MARK[l.verdict]}`, `  live   ${l.live.value}  ${MARK[l.live.verdict]}`);
    out.push("┄".repeat(80), `${t} total  close  ${probeTrancheCell(res.tranches[i]!)}`, `${"".padEnd(8)}  live   ${probeTrancheCell(res.tranchesLive[i]!)}`, "");
  }
  const e = res.escalation;
  out.push(
    `episode box: ${boxStatus(e)} · ${votesText(e)}`,
    ...e.clusters.map((c) => `  ${c.name} (${c.kind}) ${c.hits}/${c.live} live of ${c.n}${c.vote ? " — votes" : ""} · ${c.members.map((m) => `${m.id} ${m.value ?? "—"}`).join(" | ")}`),
    `family rows (display)${e.near.length ? ` · near: ${e.near.join(" · ")}` : ""}${e.unread.length ? ` · unread: ${e.unread.map(unreadWhy).join(", ")}` : ""}`,
    ...e.families.map((f) => `  ${f.name.padEnd(6)} ${f.rule} · close ${f.value} ${MARK[f.verdict]}${f.verdict === "unmet" ? " TRIPPED" : ""}${f.near ? " near" : ""} · live ${f.live!.value} ${MARK[f.live!.verdict]} · signs ${f.signs.length ? f.signs.map((g) => `${g.sign} ${g.lean}${g.block ? " BLOCK" : ""}`).join(" · ") : "—"}`),
    `XDEV ${displayText(res.display)}`,
    ...compareText(compareReads(eachId(s, closes), r), r),
    `each third fires on its own legs and gates, or the follow path (time stop · after T1 · after T2)${res.sessionsSinceExit === undefined ? ", no XDEV drawdown open" : ` — ${res.sessionsSinceExit} closes since the XDEV drawdown opened`}; a manual \`block\` on ${VETO_ROWS.join("/")} holds T2·T3 (all three once its measured half trips), any other shows on its family row only, read off \`signs[]\` of`,
    `${LADDER_LEGS.value.json} (sign ids ${SIGNS.join(", ")}); live = latest print incl. the intraday head.`,
  );
  return out.join("\n");
}

const ratioPts = (j: { dates: string[]; a: number[]; b: number[] }): Pt[] => j.dates.map((date, i) => ({ date, value: j.a[i]! / j.b[i]! }));
type Obs = { date: string; value: number; estimated?: boolean };
/** `LIVE_FEEDS` off `fetchDailyCloses` (2y — far past ewTrend's 60 closes and the follow walk): a leg that throws or reads empty → [] (its gate n/a, held); an estimated leg head, or one dated
 *  today before the US close (21:00 UTC), marks the ratio row provisional — the `live` column reads it, the close verdict does not. */
export async function liveFeeds(dailyCloses?: (sym: string) => Promise<Obs[]>, now = new Date()): Promise<Record<(typeof LIVE_FEEDS)[number], Pt[]>> {
  const [{ fetchDailyCloses }, { alignByDate }] = await Promise.all([import("../src/prices.js"), import("../src/scorers-core.js")]);
  const get = dailyCloses ?? ((sym: string) => fetchDailyCloses(sym, { now: Date.now, env: readEnv() }));
  const today = isoDay(now);
  const running = (d: string): boolean => d === today && now.getUTCHours() < 21;
  const pair = async (id: (typeof LIVE_FEEDS)[number]): Promise<Pt[]> => {
    try {
      const [a, b] = await Promise.all(LIVE_FEED_PAIRS[id].map(get));
      const est = new Set([...a!, ...b!].filter((o) => o.estimated === true || running(o.date)).map((o) => o.date));
      return ratioPts(alignByDate(a!, b!)).map((p) => (est.has(p.date) ? { ...p, provisional: true } : p));
    } catch (e) {
      console.warn(`live feed ${id} unread — ${(e as Error).message}; its gates read n/a and hold`);
      return [];
    }
  };
  return Object.fromEntries(await Promise.all(LIVE_FEEDS.map(async (id) => [id, await pair(id)] as const))) as Record<(typeof LIVE_FEEDS)[number], Pt[]>;
}
/** At `DEEP_LIMIT`: XDEV (`followOf`'s `episodes`) and every shock/episode/vol-normal anchor's series, so each scan starts where replay's stored read does. */
const DEEP_IDS: readonly (Id | ArmId)[] = ["XDEV", "LEGP_SEMIS", "MU_RS", "F1", "R2", "R5"];
/** The live read's `/api/series` limit: `DEEP_IDS` at `DEEP_LIMIT`, the rest at `LIMIT`. */
export const liveLimit = (id: Id | ArmId): number => (DEEP_IDS.includes(id) ? DEEP_LIMIT : LIMIT);
/** The live set: every `SERIES` and `LIVE_SERVED` id off `/api/series` (`liveLimit`), and `liveFeeds`. */
async function liveFetch(base: string): Promise<SeriesSet> {
  const get = (id: Id | ArmId): Promise<Pt[]> => fetchSeries(base, id, liveLimit(id));
  const [s, served, feeds] = await Promise.all([fetchEach(SERIES, get), fetchEach(LIVE_SERVED, get), liveFeeds()]);
  return { ...s, ...served, ...feeds };
}
/** `value:apply`'s re-probe: fetch the series once, then re-derive the verdict off the patched `signs` (a `block` moves the box) and the stored verdict's latched fills. */
export async function liveReverdict(base = prodBaseUrl()): Promise<(n: LadderLive) => LadderVerdict> {
  const s = await liveFetch(base);
  const prov = verdictProvisional(s);
  return (n) => toVerdict(evaluateShipped(s, n.signs, VALUE_RULES, LIVE_ARM, n.verdict, allEvents(n), n.run), prov);
}

/** No deep keyless route (the `FORWARD_ONLY` ids): `--replay=` reads them stored, exempt from the sparse throw. */
export const SHALLOW: readonly Id[] = FORWARD_ONLY;
/** Largest |upstream − stored| on the dates both hold, per id `--replay=` rebuilds upstream (XDEV/SEC0 €, MU $, ¥, HY/DGS10/DFII10 %, VIX, RS ratios, HCX dist).
 *  RSP_SPY/QQQE_QQQ have no stored counterpart (F5/SPCONC store the inverse ratio's 12-mo-high dist), so no row: same closes-provider feed as XDEV/MU; MU_OPEN/MU_CLOSE (unadjusted) likewise. */
const PARITY_TOL: Partial<Record<Id | ArmId, number>> = { XDEV: 0.5, LEGP_SEMIS: 1, F8: 2, F17: 1, F1: 0.05, R2: 0.02, MU_RS: 0.02, RS_SMH: 0.02, KBE_RS: 0.02, R4: 0.02, R5: 0.02, HCX: 0.02 };

/** Per verdict id: closes in `from` → `to` vs XDEV's; blind = none, partial = under `HOLDOUT_WINDOW.MIN_COVER` of XDEV's; `sparse` (the throw) = partial outside SHALLOW. */
export function coverage(s: SeriesSet, from: string, to: string): { n: Partial<Record<Id | ArmId, number>>; blind: (Id | ArmId)[]; partial: (Id | ArmId)[]; sparse: (Id | ArmId)[] } {
  const ids = REPLAY_IDS.filter((id) => (VERDICT_IDS as ReadonlySet<string>).has(id));
  const inWindow = (id: Id | ArmId): number => closes(s[id] ?? []).filter((p) => p.date >= from && p.date <= to).length;
  const fund = inWindow("XDEV");
  const partial = ids.filter((id) => inWindow(id) > 0 && inWindow(id) < HOLDOUT_WINDOW.MIN_COVER * fund);
  return { n: Object.fromEntries(ids.map((id) => [id, inWindow(id)])), blind: ids.filter((id) => inWindow(id) === 0), partial, sparse: partial.filter((id) => !(SHALLOW as readonly string[]).includes(id)) };
}

// ▸ arms — Stage 3; the live verdict reads `LIVE_ARM` (its roster = `LEGS`) and `followOf` from this block
/** Arm cuts, fixed before the first arm run; an arm swaps its own rows into `LEGS_SHIPPED` and is scored alone vs baseline. */
export const VALUE_ARM = {
  /** Follow path (EU-Fin `tally`/`fires`): T1 fires TIME_STOP_N closes after the exit, T2/T3 AFTER_N closes after the fill before — each only while clear, zone gate waived. */
  TIME_STOP_N: 15,
  T2_AFTER_N: 10,
  T3_AFTER_N: 15,
  /** trendT3: T3's zone gate → XDEV > MA(T3_MA_N), that MA above itself MA_RISING_LAG closes back (EU-Fin's T3 price rung). */
  T3_MA_N: 50,
  MA_RISING_LAG: EUFIN_RULES.MA_RISING_LAG,
  /** muRsGuard (EU-Fin AT1 gate): no new MU_RS_LOW_N-close low of MU_RS in the latest T2/T3 guard-N closes; `HYBRID_GUARDS` → no close past its since-shock line while MU_RS's episode is open. */
  MU_RS_LOW_N: 20,
  T2_MU_RS_GUARD_N: EUFIN_RULES.T2_AT1_GUARD_N,
  T3_MU_RS_GUARD_N: EUFIN_RULES.T3_AT1_GUARD_N,
  /** muMom: MU's return over F8's own 6-mo window. */
  MU_MOM_N: RET_WINDOW,
  /** ewTrend: RSP/SPY or QQQE/QQQ MA(FAST) > MA(MID) at T2; either one's MA(MID) above its value RISE_N closes back at T3. */
  EW_FAST_N: 20,
  EW_MID_N: 50,
  EW_RISE_N: 10,
  /** MU-report arm: T2/T3 held from EARN_HOLD_N MU closes before report date D through D+1; fast fill needs D+1's close to keep ≥ EARN_KEEP_GAP of the gap and top the EARN_HIGH_N-close high ending D. */
  EARN_HOLD_N: 5,
  EARN_HIGH_N: 20,
  EARN_KEEP_GAP: 0.5,
  /** Family arms: need 1 / ⌈FAM_T2_SHARE·N⌉ / ⌈FAM_T3_SHARE·N⌉ of the N families besides credit (`famNeed`); post-shock = since the episode exit. */
  ...FAM_SHARES,
  /** price XDEV (and banks KBE at T2): no post-exit low ×T1_NO_LOW_N / ×T2_NO_LOW_N; T3 rung = trendT3's read; T3 gate XDEV > MA(TREND_MA_N). */
  T1_NO_LOW_N: 5,
  T2_NO_LOW_N: 15,
  TREND_MA_N: 200,
  /** EU-Fin's own-shock knobs (`KNOBS`): the rates guard anchor and VIX's `volNormal`; HY's shock (credit gate + `hyGuard`) reads `VALUE_RULES`'. */
  BASE_N: EUFIN_RULES.BASE_N,
  SIGMA_N: EUFIN_RULES.SIGMA_N,
  BROKE_SD: EUFIN_RULES.BROKE_SD,
  /** vol T3 also: VIX (`R5` = VIXCLS) under VOL_K × its VIX_MEDIAN_N-close median (pre-shock while VIX's own `shockOf` on BASE_N/SIGMA_N/BROKE_SD is open) ×T3_VIX_N, or cooling (`volNormal`). */
  VIX_MEDIAN_N: 250,
  T3_VIX_N: 5,
  /** semis T2: RS_SMH > MA(RS_FAST_N) and Δ(RS_FAST_N) > 0; T3: RS_SMH > MA(T3_MA_N). */
  RS_FAST_N: 10,
  /** rates (`R2`, EU-Fin gilts): T1 no RATES_HIGH_N-close high ×T1_RATES_N (`HYBRID_GUARDS` → no close past its since-shock line while R2's shock is open); T2/T3 z(Δ RATES_DELTA_N over RATES_Z_WINDOW) < RATES_Z_MAX ×RATES_QUIET_N. */
  RATES_HIGH_N: 20,
  T1_RATES_N: 5,
  RATES_DELTA_N: 20,
  RATES_Z_WINDOW: 250,
  RATES_Z_MAX: 1,
  RATES_QUIET_N: 5,
} as const;
const A = VALUE_ARM;
/** The arm's own-shock reads (`volNormal`, the rates `guardAnchor`) on its knobs; HY's shock (credit gate + `hyGuard`) reads `VALUE_RULES`. */
const KNOBS: ShockKnobs = { BASE_N: A.BASE_N, SIGMA_N: A.SIGMA_N, BROKE_SD: A.BROKE_SD };
/** Feeds the arms read (R4 = DFII10 %, R5 = VIXCLS, KBE_RS = KBE/SPY, the closes-feed close ratios, MU bars); `deepSet` builds all, a live set only `LIVE_FEEDS` (`liveFeeds`) + `LIVE_SERVED`. */
export const ARM_SERIES = ["R4", "R5", "KBE_RS", "RSP_SPY", "QQQE_QQQ", "MU_OPEN", "MU_CLOSE"] as const;
export type ArmId = (typeof ARM_SERIES)[number];
const REPLAY_IDS: readonly (Id | ArmId)[] = [...SERIES, ...ARM_SERIES];
const trendT3: LegDef = {
  key: "t3-trend",
  tranche: "T3",
  gate: true,
  tag: tagOf({ series: ["XDEV"], job: "regime", agg: "allOf" }),
  leg: "gate: XDEV > rising MA",
  src: { kind: "dash", id: "XDEV" },
  rule: () => `> MA${A.T3_MA_N}, MA${A.T3_MA_N} rising`,
  tip: () => `XDEV's latest close above its ${A.T3_MA_N}-close MA, and that MA above where it stood ${A.MA_RISING_LAG} closes back — the last third waits for the trend to turn up.`,
  read: (_r, x) => {
    const c = x.s.XDEV;
    const [m, back] = [ma(c, A.T3_MA_N), ma(c.slice(0, -A.MA_RISING_LAG), A.T3_MA_N)];
    if (m === null || back === null) return NA;
    const ok = [last(c)!.value! > m, m > back] as const;
    // The MA prints twice: one width for the close, the MA and its lagged self.
    const w = dpCell([[last(c)!.value, m], [m, back]]);
    const [[px, mp], [mn, mb]] = [vs(last(c)!.value, m, w), vs(m, back, w)];
    return { value: `${px} ${cmp(">", `MA${A.T3_MA_N} ${mp}`, ok[0])} · MA${A.T3_MA_N} ${mn} ${cmp(">", `${mb} (${mmdd(c.at(-1 - A.MA_RISING_LAG)!.date)})`, ok[1])}`, verdict: tick(ok[0] && ok[1]) };
  },
};
const muRsGuard = (tranche: Tranche, n: number, tag: ReadTag): LegDef => ({
  key: `${tranche.toLowerCase()}-mu-rs-guard`,
  tranche,
  gate: true,
  tag,
  leg: "guard: MU_RS no new low",
  src: { kind: "dash", id: "MU_RS" },
  rule: (r) => guardRule("low", A.MU_RS_LOW_N, n, r.HYBRID_GUARDS),
  read: (r, x) => {
    const c = x.s.MU_RS;
    if (c.length < A.MU_RS_LOW_N + n) return NA;
    const at = guardAnchor(c, r.HYBRID_GUARDS);
    const got = quietRun(c, n, (i) => !(hybridBreak(c, i, "low", at) ?? newExtreme(c, i, A.MU_RS_LOW_N, "low", { guard: false })));
    return { value: vcAt(last(c)!.value, hybridCut(c, "low", at) ?? priorExt(c, A.MU_RS_LOW_N, "low"), 4), verdict: tick(got >= n), count: { got, need: n } };
  },
});
const hcxGate = (tranche: Tranche, tag: ReadTag): LegDef => ({
  key: `${tranche.toLowerCase()}-hcx-gate`,
  tranche,
  gate: true,
  tag,
  leg: "gate: capex basket HCX not RED",
  src: { kind: "dash", id: "HCX" },
  rule: () => "HCX registry state ≠ RED",
  read: (_r, x) => {
    const p = last(x.s.HCX);
    if (!p?.state) return NA;
    return { value: `${p.state}${p.value === null ? "" : ` ${pct(p.value)}`}`, verdict: tick(p.state !== "RED") };
  },
});
const muMom = (tranche: Tranche, tag: ReadTag): LegDef => ({
  key: `${tranche.toLowerCase()}-mu-mom`,
  tranche,
  gate: true,
  tag,
  leg: "confirm: MU 6-mo return > 0",
  src: { kind: "dash", id: "F8" },
  rule: () => `MU / MU[−${A.MU_MOM_N}] − 1 > 0`,
  read: (_r, x) => {
    const c = x.s.F8;
    if (c.length <= A.MU_MOM_N) return NA;
    const m = last(c)!.value! / c.at(-1 - A.MU_MOM_N)!.value! - 1;
    return { value: pct(m), verdict: tick(m > 0) };
  },
});
/** T2: fast MA over mid MA; T3: mid MA now over mid MA RISE_N closes back — either ratio passes, either unread holds. */
const ewTrend = (tranche: Tranche, tag: ReadTag): LegDef => {
  const t2 = tranche === "T2";
  return {
    key: `${tranche.toLowerCase()}-ew-trend`,
    tranche,
    gate: true,
    tag,
    leg: "confirm: equal-weight RSP/SPY · QQQE/QQQ trend",
    src: { kind: "dash", id: "RSP_SPY" },
    rule: () => (t2 ? `MA${A.EW_FAST_N} > MA${A.EW_MID_N}, either` : `MA${A.EW_MID_N} Δ${A.EW_RISE_N} > 0, either`),
    tip: () =>
      t2
        ? `Equal-weight vs cap-weight ratios RSP/SPY and QQQE/QQQ: either one's ${A.EW_FAST_N}-close MA above its ${A.EW_MID_N}-close MA — breadth widening, not a rally carried by the megacaps.`
        : `Equal-weight vs cap-weight ratios RSP/SPY and QQQE/QQQ: either one's ${A.EW_MID_N}-close MA above where it stood ${A.EW_RISE_N} closes back — breadth widening, not a rally carried by the megacaps.`,
    read: (_r, x) => {
      const parts = (["RSP_SPY", "QQQE_QQQ"] as const).map((id) => {
        const c = x.s[id] ?? [];
        return [id, ma(c, t2 ? A.EW_FAST_N : A.EW_MID_N), ma(t2 ? c : c.slice(0, -A.EW_RISE_N), A.EW_MID_N)] as const;
      });
      if (parts.some(([, f, s]) => f === null || s === null)) return NA;
      // T3's cut is the MA as of EW_RISE_N closes back: its date prints.
      const at = (id: (typeof parts)[number][0]): string => ((p) => (t2 || !p ? "" : ` (${mmdd(p.date)})`))((x.s[id] ?? []).at(-1 - A.EW_RISE_N));
      return { value: parts.map(([id, f, s]) => `${id} ${vc(f, s, 4)}${at(id)}${f! > s! ? "✓" : "✗"}`).join(" · "), verdict: tick(parts.some(([, f, s]) => f! > s!)) };
    },
  };
};
// Source: SEC EDGAR Item 2.02 8-K filing dates, CIK 0000723125 (https://data.sec.gov/submissions/CIK0000723125.json); after-close US date D.
export const MU_EARN_DATES = [
  "2018-09-20", "2018-12-18", "2019-03-20", "2019-06-25", "2019-09-26", "2019-12-18", "2020-03-25", "2020-06-29",
  "2020-09-29", "2021-01-07", "2021-03-31", "2021-06-30", "2021-09-28", "2021-12-20", "2022-03-29", "2022-06-30",
  "2022-09-29", "2022-12-21", "2023-03-28", "2023-06-28", "2023-09-27", "2023-12-20", "2024-03-20", "2024-06-26",
  "2024-09-25", "2024-12-18", "2025-03-20", "2025-06-25", "2025-09-23", "2025-12-17", "2026-03-18", "2026-06-24",
  "2026-09-30",
];
/** MU-report arm, per report D: hold `from` → `d1` (first MU session after D; open-ended until it prints), `fast` = D+1's reaction qualified. */
export type EarnWindow = { d: string; from: string; d1: string; fast: boolean };
/** MU_EARN_DATES → windows off one closes-provider bar set (unadjusted open/close, same basis); a D before the bars skips. */
export function earnWindows(open: Pt[], close: Pt[], dates: readonly string[] = MU_EARN_DATES): EarnWindow[] {
  const o = new Map(open.map((p) => [p.date, p.value]));
  return dates.flatMap((d): EarnWindow[] => {
    const i = close.findLastIndex((p) => p.date <= d);
    if (i < 0) return [];
    const [c0, next] = [close[i]!.value!, close[i + 1]];
    const o1 = next ? o.get(next.date) : undefined;
    const high = i + 1 >= A.EARN_HIGH_N ? Math.max(...vals(close.slice(i + 1 - A.EARN_HIGH_N, i + 1))) : Infinity;
    const fast = next !== undefined && o1 != null && o1 > c0 && next.value! - c0 >= A.EARN_KEEP_GAP * (o1 - c0) && next.value! > high;
    return [{ d, from: close[Math.max(0, i - A.EARN_HOLD_N)]!.date, d1: next?.date ?? "9999-12-31", fast }];
  });
}
/** `follow` = the time stop + auto-follow; `earn` = the MU report hold + fast T2 (`EarnWindow`s); `defs` = the arm's roster; `families` = N of a family arm (`famNeed`). */
export type ValueArm = { name: string; note: string; follow: boolean; earn?: boolean; families?: number; defs: readonly LegDef[] };
const swap = (key: string, d: LegDef): LegDef[] => LEGS_SHIPPED.map((l) => (l.key === key ? d : l));
const ALONE: readonly ValueArm[] = [
  { name: "baseline", note: "pre-stack VALUE_RULES + LEGS_SHIPPED", follow: false, defs: LEGS_SHIPPED },
  { name: "B5 stop+follow+MA", note: `T1 +${A.TIME_STOP_N} after the drawdown opened · T2/T3 +${A.T2_AFTER_N}/+${A.T3_AFTER_N} after the latched fill before, while clear w/o zone · T3 zone → XDEV > rising MA${A.T3_MA_N}`, follow: true, defs: swap("t3-zone", trendT3) },
  { name: "B7 MU_RS no low", note: `T2/T3 gate: no new ${A.MU_RS_LOW_N}-close MU_RS low ×${A.T2_MU_RS_GUARD_N}/×${A.T3_MU_RS_GUARD_N} (n/a holds, as every value gate)`, follow: false, defs: [...LEGS_SHIPPED, muRsGuard("T2", A.T2_MU_RS_GUARD_N, tagOf({ series: ["MU_RS"], job: "relative", agg: "allOf" })), muRsGuard("T3", A.T3_MU_RS_GUARD_N, tagOf({ series: ["MU_RS"], job: "relative", agg: "allOf" }))] },
  { name: "B9a HCX not RED", note: "T2/T3 gate: HCX capex basket (GOOGL·META·MSFT·AMZN ÷ SPY, 12-mo-high dist) registry state ≠ RED", follow: false, defs: [...LEGS_SHIPPED, hcxGate("T2", tagOf({ series: ["HCX"], job: "level", agg: "allOf" })), hcxGate("T3", tagOf({ series: ["HCX"], job: "level", agg: "allOf" }))] },
  { name: "B9b MU 6m > 0", note: `T2 gate: MU return over ${A.MU_MOM_N} closes (F8's window) > 0`, follow: false, defs: [...LEGS_SHIPPED, muMom("T2", tagOf({ series: ["F8"], job: "level", agg: "allOf" }))] },
  { name: "B9c EW trend", note: `RSP/SPY or QQQE/QQQ: T2 gate MA${A.EW_FAST_N} > MA${A.EW_MID_N} · T3 gate MA${A.EW_MID_N} Δ${A.EW_RISE_N} > 0`, follow: false, defs: [...LEGS_SHIPPED, ewTrend("T2", tagOf({ series: ["RSP_SPY", "QQQE_QQQ"], job: "regime", agg: "allOf", indicator: "RSP/SPY · QQQE/QQQ" })), ewTrend("T3", tagOf({ series: ["RSP_SPY", "QQQE_QQQ"], job: "speed", agg: "allOf", indicator: "RSP/SPY · QQQE/QQQ", variant: "maΔ10" }))] },
  { name: "B2-fast MU report", note: `T2/T3 held ${A.EARN_HOLD_N} MU closes before report D → D+1 · fast T2 at the first XDEV close after D+1 iff open(D+1) > close(D), D+1 keeps ≥ ${A.EARN_KEEP_GAP} of the gap, close(D+1) > ${A.EARN_HIGH_N}-close high to D (MU unadjusted bars, ${MU_EARN_DATES.length} reports from ${MU_EARN_DATES[0]})`, follow: false, earn: true, defs: LEGS_SHIPPED },
];
/** Stack arms over LEGS_SHIPPED (`B`): each arm's in-slot swaps (defs[i] ≠ B[i]) + its appended legs, follow/earn ORed; a clashing slot, key or non-B-prefixed arm throws. */
export function stackArms(name: string, ...arms: readonly ValueArm[]): ValueArm {
  const B = LEGS_SHIPPED;
  const slots = [...B];
  const added = new Map<string, LegDef>();
  for (const a of arms) {
    if (a.defs.length < B.length || a.defs.some((d, i) => i < B.length && d !== B[i] && B.includes(d))) throw new Error(`stackArms: ${a.name} defs not LEGS_SHIPPED-prefixed`);
    a.defs.forEach((d, i) => {
      if (i >= B.length) {
        if (added.has(d.key)) throw new Error(`stackArms: ${a.name} re-adds ${d.key}`);
        added.set(d.key, d);
      } else if (d !== B[i]) {
        if (slots[i] !== B[i]) throw new Error(`stackArms: ${a.name} re-swaps ${B[i]!.key}`);
        slots[i] = d;
      }
    });
  }
  const defs = [...slots, ...added.values()];
  const dup = defs.find((d, i) => defs.findIndex((e) => e.key === d.key) !== i);
  if (dup) throw new Error(`stackArms: ${name} duplicate key ${dup.key}`);
  return { name, note: `${arms.map((a) => a.name).join(" + ")}, stacked`, follow: arms.some((a) => a.follow), earn: arms.some((a) => a.earn === true), defs };
}
const alone = (prefix: string): ValueArm => ALONE.find((a) => a.name.startsWith(`${prefix} `))!;
const S1 = stackArms("S1 B5+B7+B9a+B9c", ...["B5", "B7", "B9a", "B9c"].map(alone));
/** A family arm's need per tranche: 1 / ⌈FAM_T2_SHARE·n⌉ / ⌈FAM_T3_SHARE·n⌉ (`tally` caps at it, NEED_SLACK still applies). */
export const famNeed = (t: Tranche, n: number): number => famNeedOf(t, n, A);
type Rung = Pick<LegDef, "rule" | "read" | "tag"> & { src?: LegDef["src"] };
export type Fam = { name: string; rungs: readonly [LegDef, LegDef, LegDef] };
/** One family = one rung per tranche, keyed `t<k>-<name>`; a rung without `src` reads the family's. */
const fam = (name: string, leg: string, src: LegDef["src"], rungs: readonly [Rung, Rung, Rung]): Fam => ({
  name,
  rungs: famRows(name, leg, src, rungs) as unknown as Fam["rungs"],
});
const shipped = (key: string): LegDef => LEGS_SHIPPED.find((d) => d.key === key)!;
const fix = fixNum;
const noLowRung = (id: "XDEV" | "KBE", n: number, tag: ReadTag): Rung => ({
  tag,
  rule: () => `no new low since the drawdown opened ×${n}`,
  read: (_r, x) => {
    const c = x.s[id];
    const nl = noLowRun(c, x.exit, n);
    if (nl === null) return NA;
    return { value: vcAt(last(c)!.value, nl.low), verdict: tick(nl.got >= n), count: { got: nl.got, need: n } };
  },
});
/** HY's three retrace rungs (`ladder-credit.ts`), each a gate in `famArm`. */
const CREDIT = fam(CREDIT_FAM.name, CREDIT_FAM.leg, CREDIT_FAM.src, creditRungs(tagOf({ series: ["F1"], job: "recovery", agg: "allOf" })));
const PRICE = fam("price", "price XDEV", { kind: "dash", id: "XDEV" }, [
  noLowRung("XDEV", A.T1_NO_LOW_N, tagOf({ series: ["XDEV"], job: "recovery", agg: "kOfN" })),
  noLowRung("XDEV", A.T2_NO_LOW_N, tagOf({ series: ["XDEV"], job: "recovery", agg: "kOfN" })),
  { rule: trendT3.rule, read: trendT3.read, tag: tagOf({ series: ["XDEV"], job: "regime", agg: "kOfN" }) },
]);
/** `volNormal`: VIX under VOL_K × its VIX_MEDIAN_N median (pre-shock while VIX's own shock is open) ×T3_VIX_N, or cooling; n/a short of a full window. */
const vixUnder: Rung["read"] = (_r, x) => {
  const c = x.s.R5 ?? [];
  const n = volNormal(c, KNOBS, A.VIX_MEDIAN_N);
  if (n === null || n.n < A.VIX_MEDIAN_N) return NA;
  const got = quietRun(c, A.T3_VIX_N, (i) => c[i]!.value! < n.cut);
  return { value: `${vc(last(c)!.value, n.cut)}${n.cooling ? " cooling" : ""}`, verdict: tick(got >= A.T3_VIX_N || n.cooling), count: { got, need: A.T3_VIX_N } };
};
const vixRule = (): string => `VIX < ${knob(VOL_K)}× pre-shock ${A.VIX_MEDIAN_N}d median (latest ${A.VIX_MEDIAN_N}d with no VIX shock open) ×${A.T3_VIX_N} or cooling (≥${knob(VOL_COOL * 100)}% off peak, falling ×2)`;
const t3Rv = volVsBase((r) => r.RV_SLOW_N, (r) => r.T3_RV_MULT);
const VOLF = fam("vol", "vol XDEV realized", VOL.src, [
  { ...volRolled, tag: tagOf({ series: ["XDEV"], job: "composite", agg: "kOfN", indicator: "XDEV" }) },
  { ...volVsBase((r) => r.RV_N, (r) => r.T2_RV_MULT), tag: tagOf({ series: ["XDEV"], job: "recovery", agg: "kOfN" }) },
  { tag: tagOf({ series: ["XDEV", "R5"], job: "composite", agg: "kOfN", indicator: "XDEV RV · VIX" }), rule: (r) => `${t3Rv.rule(r)} · ${vixRule()}`, read: (r, x) => ((a, b) => ({ ...both(a, b), value: `RV${r.RV_SLOW_N} ${a.value}${MARK[a.verdict]} · VIX ${b.value}${MARK[b.verdict]}`, ...(b.count && { count: b.count }) }))(t3Rv.read(r, x), vixUnder(r, x)) },
]);
const rsVsMa = (n: number, mom: boolean, tag: ReadTag): Rung => ({
  tag,
  src: { kind: "dash", id: "RS_SMH" },
  rule: () => `RS_SMH > MA${n}${mom ? `, Δ${n} > 0` : ""}`,
  read: (_r, x) => {
    const c = x.s.RS_SMH;
    const [m, d] = [ma(c, n), delta(c, n)];
    if (m === null || d === null) return NA;
    const [px, mp] = vs(last(c)!.value, m, 4);
    return { value: `${px} ${cmp(">", `MA${n} ${mp}`, last(c)!.value! > m)}${mom ? ` Δ${n} ${vs(d, 0, 4)[0]} ${cmp(">", "0", d > 0)}` : ""}`, verdict: tick(last(c)!.value! > m && (!mom || d > 0)) };
  },
});
const SEMIS = fam("semis", "semis SEC0 · RS_SMH", { kind: "dash", id: "LEGP_SEMIS" }, [
  // T1's rung is SEC0 alone.
  { rule: (r) => shipped("t1-smh").rule(r), read: (r, x) => shipped("t1-smh").read(r, x), tag: tagOf({ series: ["LEGP_SEMIS"], job: "relative", agg: "kOfN" }) },
  rsVsMa(A.RS_FAST_N, true, tagOf({ series: ["RS_SMH"], job: "composite", agg: "kOfN" })),
  rsVsMa(A.T3_MA_N, false, tagOf({ series: ["RS_SMH"], job: "regime", agg: "kOfN" })),
]);
const ratesZ: Rung = {
  tag: tagOf({ series: ["R2"], job: "speed", agg: "kOfN" }),
  rule: () => `z(Δ${A.RATES_DELTA_N}) < ${A.RATES_Z_MAX} ×${A.RATES_QUIET_N}`,
  read: (_r, x) => {
    const { z, got } = speedQuiet(x.s.R2, { n: A.RATES_DELTA_N, window: A.RATES_Z_WINDOW, zMax: A.RATES_Z_MAX, quiet: A.RATES_QUIET_N });
    if (z === null) return NA;
    return { value: zVs(z, A.RATES_Z_MAX), verdict: tick(got >= A.RATES_QUIET_N), count: { got, need: A.RATES_QUIET_N } };
  },
};
const RATES = fam("rates", "rates US 10y", { kind: "dash", id: "R2" }, [
  {
    tag: tagOf({ series: ["R2"], job: "relative", agg: "kOfN" }),
    rule: (r) => guardRule("high", A.RATES_HIGH_N, A.T1_RATES_N, r.HYBRID_GUARDS),
    read: (r, x) => {
      const c = x.s.R2;
      if (c.length < A.RATES_HIGH_N + A.T1_RATES_N) return NA;
      const at = guardAnchor(c, r.HYBRID_GUARDS, KNOBS);
      const got = quietRun(c, A.T1_RATES_N, (i) => !(hybridBreak(c, i, "high", at) ?? newExtreme(c, i, A.RATES_HIGH_N, "high", { guard: false })));
      return { value: vcAt(last(c)!.value, hybridCut(c, "high", at) ?? priorExt(c, A.RATES_HIGH_N, "high")), verdict: tick(got >= A.T1_RATES_N), count: { got, need: A.T1_RATES_N } };
    },
  },
  ratesZ,
  ratesZ,
]);
const BANKS = fam("banks", "banks KBE", { kind: "dash", id: "KBE" }, [
  shipped("t2-kbe"),
  noLowRung("KBE", A.T2_NO_LOW_N, tagOf({ series: ["KBE"], job: "recovery", agg: "kOfN" })),
  {
    tag: tagOf({ series: ["KBE_RS"], job: "regime", agg: "kOfN" }),
    src: { kind: "dash", id: "KBE_RS" },
    rule: () => `KBE/SPY > MA${A.T3_MA_N}`,
    read: (_r, x) => {
      const c = x.s.KBE_RS ?? [];
      const m = ma(c, A.T3_MA_N);
      return m === null ? NA : { value: `${fix(last(c)!.value, 4)}/${fix(m, 4)}`, verdict: tick(last(c)!.value! > m) };
    },
  },
]);
export const FAMS = { PRICE, VOL: VOLF, CREDIT, SEMIS, RATES, BANKS } as const;
const trend200: LegDef = {
  key: "t3-ma200",
  tranche: "T3",
  gate: true,
  tag: tagOf({ series: ["XDEV"], job: "regime", agg: "allOf" }),
  leg: "gate: XDEV > MA200",
  src: { kind: "dash", id: "XDEV" },
  rule: () => `close > MA${A.TREND_MA_N}`,
  read: (_r, x) => ((m) => (m === null ? NA : { value: vc(last(x.s.XDEV)!.value, m), verdict: tick(last(x.s.XDEV)!.value! > m) }))(ma(x.s.XDEV, A.TREND_MA_N)),
};
/** The stacked arm's gates less its zone/trend gates, plus T3's veto and MA200 gate, spread per tranche after that tranche's family rungs; follow as it.
 *  Credit's rung is a gate at every tranche (`asGate`; n/a holds), so `famNeed` counts the other families only. */
const famArm = (name: string, fams: readonly Fam[]): ValueArm => {
  const gates = [...S1.defs.filter((d) => d.gate && !d.key.endsWith("-zone") && d !== trendT3), veto("T3", tagOf({ series: ["XDEV", "F8"], job: "speed", agg: "allOf", indicator: "XDEV · MU", variant: "σret" })), trend200, ...(["T1", "T2", "T3"] as const).map((t) => escLeg(`${t.toLowerCase()}-esc`, t, tagOf({ series: BOX_SERIES, job: "composite", agg: "allOf", indicator: "escalation box" })))];
  const rung = (f: Fam, k: number): LegDef => (f === CREDIT ? asGate(f.rungs[k]!) : f.rungs[k]!);
  const defs = (["T1", "T2", "T3"] as const).flatMap((t, k) => [...fams.map((f) => rung(f, k)), ...gates.filter((g) => g.tranche === t)]);
  const n = fams.filter((f) => f !== CREDIT).length;
  return { name, note: `families ${fams.map((f) => f.name).join("·")}, need 1/${famNeed("T2", n)}/${famNeed("T3", n)} of the ${n} besides credit · credit gates every tranche · S1 gates w/o zones + T3 veto + T3 XDEV > MA${A.TREND_MA_N} · post-shock = episode exit`, follow: S1.follow, families: n, defs };
};
const P4 = [PRICE, VOLF, CREDIT, SEMIS];
export const VALUE_ARMS: readonly ValueArm[] = [...ALONE, famArm("P4 families", P4), famArm("P5 +rates", [...P4, RATES]), famArm("P6 +rates+banks", [...P4, RATES, BANKS]), S1];
/** The shipped ladder ([USER] 2026-10-11): the `famArm` with rates — its roster is the live `LEGS`, its `follow` the live follow path. */
export const LIVE_ARM: ValueArm = VALUE_ARMS.find((a) => a.name.startsWith("P5 "))!;
export const LEGS: readonly LegDef[] = LIVE_ARM.defs;
/** Every static read the live verdict emits — the `LEGS` rows (key = row key) + the box families (key = family name) — for `duplicateReads` / `lint:ladder-reads`. */
export const TAGGED_READS: readonly TaggedRead[] = [...LEGS.map((d) => ({ key: d.key, tag: d.tag })), ...FAMILIES.map((f) => ({ key: f, tag: FAMILY_TAG[f] }))];
/** The served + live-feed ids the verdict reads — every `LEGS` row and the escalation box, so a display-only comparator (`compareReads`)
 *  never enters it and a new leg's id enters it with no list to update. */
export const VERDICT_IDS: ReadonlySet<LiveId> = new Set(readIds((x) => tranchesAt(x, VALUE_RULES)));
export type { Follow };
/** The open `episodes` exit over XDEV closes (no episode end yet, as `replayValue` walks it); undefined = none open. */
export const openExit = (c: SeriesSet): string | undefined => openExitOf(c.XDEV);
/** A `follow` arm's live anchors: the `openExit`, each third's first `firesAt` close after it, and `n` = closes since the exit; null = no open exit, or no follow.
 *  A `latched` date (the stored verdict's `filledSince`) on/after this exit is that third's fill as-is, so today's signs cannot un-fill it; one older than the exit drops. `events` = the live deciding events (`allFizzled`). */
export function followOf(arm: ValueArm, c: SeriesSet, signs: readonly LadderSign[], r: Rules, latched: readonly (string | null)[] = [], events: readonly LadderEventDone[] = []): Follow | null {
  const exit = arm.follow ? openExit(c) : undefined;
  if (exit === undefined) return null;
  return walkFollow(exit, c.XDEV.filter((p) => p.date > exit), latched, (d, fills) => firesAt(arm, { s: eachId(c, upTo(d)), signs }, r, fills, c.XDEV, exit, d, [], allFizzled(events, "T2", d)));
}
const VIA: readonly Via[] = ["time stop", "after T1", "after T2"];
/** `tranchesAt` on `arm`'s roster, `met` = `firesAt` over `f` at `x`'s newest XDEV print: a third met on the follow path alone names it in `via`; a filled third
 *  carries its fill as `since` (`fill`), met or not, so the stored verdict keeps the latch `followOf` reads next run. */
export function followed(arm: ValueArm, x: Inputs, r: Rules, f: Follow | null, events: readonly LadderEventDone[] = []): TrancheResult[] {
  const d = last(x.s.XDEV)?.date;
  const fired = f && d ? firesAt(arm, x, r, f.fills, x.s.XDEV, f.exit, d, [], allFizzled(events, "T2", d)) : null;
  return followedOf(tranchesAt(x, r, arm.defs, arm.families), fired, f?.fills, d, (k) => VIA[k]!);
}
/** Which thirds fire at `d`: own roster ready, or (a `follow` arm) zone-waived clear and T1 TIME_STOP_N closes of `px` past `exit` / T2·T3 AFTER_N past the fill before;
 *  an `earn` arm holds T2/T3 inside a window and fires T2 on the first `px` close after a fast window's D+1. `fizzled` (live only) fires a zone-waived-clear T2 on T1's fill close `d`.
 *  `clearBox` = the counterfactual with the escalation box cleared (its `-esc` gate rows met, `boxHolds` false) — `boxBinds`' "would fire" half. */
export function firesAt(arm: ValueArm, x: Inputs, r: Rules, fills: readonly (string | null)[], px: Pt[], exit: string, d: string, wins: readonly EarnWindow[] = [], fizzled = false, clearBox = false): boolean[] {
  const legs = ((ls) => (clearBox ? ls.map((l) => (l.key.endsWith("-esc") ? { ...l, verdict: "met" as const } : l)) : ls))(legsAt({ ...x, exit }, r, arm.defs));
  const esc = ((e) => (clearBox ? { ...clearedBox(e), tripped: 0, hits: [] } : e))(escalation(x, r));
  const ew = arm.earn ? wins : [];
  const fast = ew.some((w) => w.fast && px.find((p) => p.date > w.d1)?.date === d);
  const hold = ew.some((w) => w.from <= d && d <= w.d1);
  const out = (["T1", "T2", "T3"] as const).map((t, k) => {
    if (k === 1 && fast) return true;
    if (k > 0 && hold) return false;
    if (tally(t, legs, r, esc, arm.families).ready) return true;
    if (!arm.follow || !tally(t, legs.filter((l) => !l.key.endsWith("-zone")), r, esc).clear) return false;
    const since = k === 0 ? exit : fills[k - 1];
    return since !== null && since !== undefined && px.filter((p) => p.date > since && p.date <= d).length >= [A.TIME_STOP_N, A.T2_AFTER_N, A.T3_AFTER_N][k]!;
  });
  return fizzleFill(out, fills, d, fizzled, () => tally("T2", legs.filter((l) => !l.key.endsWith("-zone")), r, esc).clear);
}
/** A binding close: some unfilled third the box holds (`boxHolds`) and `fired` left out fires with the box cleared. */
export function boxBinds(arm: ValueArm, x: Inputs, r: Rules, fills: readonly (string | null)[], fired: readonly boolean[], px: Pt[], exit: string, d: string, wins: readonly EarnWindow[] = []): boolean {
  const esc = escalation(x, r);
  const cleared = firesAt(arm, x, r, fills, px, exit, d, wins, false, true);
  return (["T1", "T2", "T3"] as const).some((t, k) => fills[k] === null && !fired[k] && cleared[k] && boxHolds(t, esc));
}
// ◂ arms

/** EU-Fin `replay()` over XDEV: per `episodes` exit, each third's first close after it `firesAt` (no sign rows, series cut PRE_DAYS before the shock); a third bought at each fill, marked at the end.
 *  `binding` = also record each episode's `boxBinds` closes (one per close, however many thirds bind); fills unchanged. */
export function replayValue(s: SeriesSet, k: ReplayKnobs = REPLAY, r: Rules = VALUE_RULES, arm: ValueArm = VALUE_ARMS[0]!, binding = false): (EpisodeResult & { binding?: string[] })[] {
  const c = eachId(s, closes);
  const wins = arm.earn ? earnWindows(c.MU_OPEN ?? [], c.MU_CLOSE ?? []) : [];
  return episodes(c.XDEV, k).map((e) => {
    const cut = eachId(c, episodeWindow(e, k));
    const fills: (string | null)[] = [null, null, null];
    const bind: string[] = [];
    for (const p of cut.XDEV.filter((q) => q.date > e.exit)) {
      const x: Inputs = { s: eachId(cut, upTo(p.date)), signs: [] };
      const fired = firesAt(arm, x, r, fills, cut.XDEV, e.exit, p.date, wins);
      if (binding && boxBinds(arm, x, r, fills, fired, cut.XDEV, e.exit, p.date, wins)) bind.push(p.date);
      fired.forEach((f, i) => f && (fills[i] ??= p.date));
      if (fills.every((f) => f !== null)) break;
    }
    return { ...scoreEpisode(c.XDEV, e, fills), ...(binding && { binding: bind }) };
  });
}

/** `--replay=why:<window>`: each `replayValue` fill's own rows at its fill close, routed as `firesAt` fired it — `count` (criteria met/need), `fast MU report` (earn T2)
 *  or the follow path's `VIA` (`time stop` · `after T1` · `after T2`); the replay passes no events, so the fizzle fill cannot fire — a fill that is none of these throws. */
export function whyFills(s: SeriesSet, k: ReplayKnobs = REPLAY, r: Rules = VALUE_RULES, arm: ValueArm = LIVE_ARM): WhyRow[] {
  const c = eachId(s, closes);
  const wins = arm.earn ? earnWindows(c.MU_OPEN ?? [], c.MU_CLOSE ?? []) : [];
  return replayValue(s, k, r, arm).flatMap((e) => e.fills.flatMap((d, i): WhyRow[] => {
    if (d === null) return [];
    const t = (["T1", "T2", "T3"] as const)[i]!;
    const cut = eachId(c, episodeWindow(e, k));
    const x: Inputs = { s: eachId(cut, upTo(d)), signs: [] };
    const legs = legsAt({ ...x, exit: e.exit }, r, arm.defs);
    const res = tally(t, legs, r, escalation(x, r), arm.families);
    // `firesAt` sans earn windows, over the fills latched before `d`: true and not ready = the follow path.
    const follow = firesAt(arm, x, r, e.fills.map((f) => (f !== null && f < d ? f : null)), cut.XDEV, e.exit, d)[i]!;
    const fast = i === 1 && wins.some((w) => w.fast && cut.XDEV.find((p) => p.date > w.d1)?.date === d);
    const via = fast ? "fast MU report" : res.ready ? `count ${res.metCount}/${res.need}` : follow ? VIA[i]! : null;
    if (via === null) throw new Error(`whyFills: ${arm.name} ${t} ${d} filled by none of its count, follow path or fast MU report`);
    return [{ exit: e.exit, tranche: t, date: d, trough: e.drops[i]?.trough ?? null, rows: legs.filter((l) => l.tranche === t).map((l) => ({ key: l.key.replace(/^t\d-/, ""), gate: l.gate, verdict: l.verdict })), via }];
  }));
}

/** The ids `deepSet` rebuilds through `DEEP_ROUTES` (`ladder-replay-feeds.ts`) — one builder per shared id; a `SHALLOW` id stays stored. */
export const DEEP_SHARED = ["LEGP_SEMIS", "F8", "F17", "F1", "R2", "R4", "R5", "MU_RS", "RS_SMH", "HCX"] as const satisfies readonly (Id | ArmId)[];
type DeepId = (typeof DEEP_SHARED)[number] | "XDEV" | "KBE_RS" | "RSP_SPY" | "QQQE_QQQ" | "MU_OPEN" | "MU_CLOSE";
function memo<T>(f: (k: string) => Promise<T>): (k: string) => Promise<T> {
  const m = new Map<string, Promise<T>>();
  return (k) => m.get(k) ?? (m.set(k, f(k)), m.get(k)!);
}
const dailyCloses = memo(async (sym) => (await import("../src/prices.js")).fetchDailyCloses(sym, { deep: true, now: Date.now, env: readEnv() }));
const closesBars = memo<OcBar[]>(async (sym) => noFreeSource(`open/close bars ${sym}`));
/** `deepSet`'s upstream builder per id: `DEEP_SHARED` ids are `DEEP_ROUTES`' own functions (same reference), Value-only ids (XDEV + the arm feeds) build here. */
export function deepBuilders(): Record<DeepId, () => Promise<Pt[]>> {
  const shared = Object.fromEntries(DEEP_SHARED.map((id) => [id, DEEP_ROUTES[id] ?? ((): never => { throw new Error(`DEEP_ROUTES lacks ${id}`); })()])) as Record<(typeof DEEP_SHARED)[number], () => Promise<Pt[]>>;
  const obs = (o: readonly { date: string; value: number }[]): Pt[] => o.map((x) => ({ date: x.date, value: x.value }));
  const ratio = async (a: string, b: string): Promise<Pt[]> => {
    const [{ alignByDate }, x, y] = await Promise.all([import("../src/scorers-core.js"), dailyCloses(a), dailyCloses(b)]);
    return ratioPts(alignByDate(x, y));
  };
  return {
    ...shared,
    XDEV: async () => dropBadPrints("XDEV", obs(await dailyCloses("XDEV.DE"))),
    KBE_RS: async () => {
      const [{ relStrengthBreakReadingSeries }, { KBE_RS }, kbe, spy] = await Promise.all([import("../src/scorers-price.js"), import("../src/registry-price.js"), dailyCloses("KBE"), dailyCloses("SPY")]);
      return relStrengthBreakReadingSeries(KBE_RS, kbe, spy).map((x): Pt => ({ date: x.date, value: x.level, state: x.state, decision: x.decision ?? null }));
    },
    RSP_SPY: () => ratio("RSP", "SPY"),
    QQQE_QQQ: () => ratio("QQQE", "QQQ"),
    MU_OPEN: async () => (await closesBars("MU")).map((b) => ({ date: b.date, value: b.open })),
    MU_CLOSE: async () => (await closesBars("MU")).map((b) => ({ date: b.date, value: b.close })),
  };
}

/** `--replay=`'s feeds: stored verdict ids start 2023 on, so each with a deep route is rebuilt upstream (parity vs stored, throws past PARITY_TOL); the rest stored; display ids read empty.
 *  F1 = the committed `scripts/backtest/data/hyoas.csv` (2008-03 → 2026-07) before stored's first close, stored on. */
async function deepSet(base: string): Promise<SeriesSet> {
  const up = Object.fromEntries(await Promise.all(Object.entries(deepBuilders()).map(async ([id, build]) => [id, await build()] as const))) as Partial<SeriesSet>;
  const storedIds = [...new Set<Id | ArmId>([...SERIES.filter((id) => VERDICT_IDS.has(id)), ...(Object.keys(PARITY_TOL) as (Id | ArmId)[])])];
  const stored: Partial<SeriesSet> = await fetchEach(storedIds, (id) => fetchSeries(base, id, DEEP_LIMIT));
  const checks = (Object.keys(PARITY_TOL) as (Id | ArmId)[]).map((id) => ({ id, ...parity(up[id]!, stored[id]!) }));
  console.log(`parity vs stored (max |Δ| over n shared dates): ${checks.map((x) => `${x.id} ${x.max.toFixed(3)}/${x.n}`).join(" · ")}`);
  const off = checks.filter((x) => x.n === 0 || x.max > PARITY_TOL[x.id]!);
  if (off.length) throw new Error(`replay feeds disagree with the stored series: ${off.map((x) => x.id).join(", ")}`);
  const f1From = stored.F1![0]?.date ?? "9999";
  const merged: Partial<SeriesSet> = { ...stored, ...up, F1: [...up.F1!.filter((p) => p.date < f1From), ...stored.F1!] };
  return Object.fromEntries(REPLAY_IDS.map((id) => [id, (merged[id] ?? []).filter((p) => !isWeekend(p.date))])) as SeriesSet;
}

/** `--replay=holdout` (the `HOLDOUT_WINDOW`) | `--replay=sweep` (REPLAY.FROM → today): the baseline scorecard EU-Fin's holdout prints, judged by its `holdoutVerdict`.
 *  `--replay=why:holdout` | `why:sweep`: the same window + feeds, `whyTable` of `whyFills` — which rows carried each fill.
 *  `--replay=drift:holdout` | `drift:sweep`: the same window's feeds, then `fillDrift` of the shipped form (`LIVE_ARM`'s row of the arms table) against itself — the identity run; a candidate form swaps the second `ReplayRun`. */
async function replayScorecard(base: string, replayArg: string): Promise<void> {
  const mode = (["drift", "p0", "why"] as const).find((m) => replayArg.startsWith(`${m}:`));
  const win = mode ? replayArg.slice(mode.length + 1) : replayArg;
  if (win !== "holdout" && win !== "sweep") throw new Error(`--replay=${replayArg}: holdout | sweep | drift:holdout | drift:sweep | p0:holdout | p0:sweep | why:holdout | why:sweep`);
  const today = isoDay(new Date());
  const [from, to] = win === "holdout" ? [HOLDOUT_WINDOW.FROM, HOLDOUT_WINDOW.TO] : [REPLAY.FROM, today];
  const all = await deepSet(base);
  const s = eachId(all, (c) => c.filter((p) => p.date >= (win === "holdout" ? HOLDOUT_WINDOW.FEED_FROM : "") && p.date <= to));
  const cov = coverage(s, from, to);
  console.log(`closes in ${from} → ${to}: ${Object.entries(cov.n).map(([id, n]) => `${id} ${n}`).join(" · ")}`);
  if (cov.sparse.length) throw new Error(`replay feeds short in the window: ${cov.sparse.join(", ")}`);
  if (mode === "p0") {
    const sum = (ar: (EpisodeResult & { binding?: string[] })[]) => ar.map((e) => classifyBinding(s.XDEV, e, e.binding!)).reduce((t, b) => ({ esc: t.esc + b.esc, fizzle: t.fizzle + b.fizzle }), { esc: 0, fizzle: 0 });
    const rows = ([["ruled", LIVE_ARM]] as const).map(([name, a]) => {
      const ar = replayValue(s, { ...REPLAY, FROM: from }, VALUE_RULES, a, true);
      const vd = holdoutVerdict(ar);
      // `cov.sparse` is the short set this probe already throws on above, so acceptance reads THIN only off `vd.thin`.
      return { arm: name, ...sum(ar), pass: vd.pass, acceptance: acceptance(vd, cov.sparse) };
    });
    console.log(`${replayArg} ${from} → ${to} · ${LIVE_ARM.name}: binding days (an unfilled third the box holds that fires with the box cleared)\n${bindingTable(rows)}`);
    return;
  }
  if (mode === "why") {
    console.log(`${replayArg} ${from} → ${to} · ${LIVE_ARM.name} (shipped) · each fill's own rows at its fill close\n${whyTable(whyFills(s, { ...REPLAY, FROM: from }))}`);
    return;
  }
  if (mode === "drift") {
    const shipped = (k: ReplayKnobs): EpisodeResult[] => replayValue(s, k, VALUE_RULES, LIVE_ARM);
    console.log(`${replayArg} ${from} → ${to} · ${LIVE_ARM.name} vs itself\n${driftTable(fillDrift(s.XDEV, shipped, shipped, { ...REPLAY, FROM: from }))}`);
    return;
  }
  const rows = replayValue(s, { ...REPLAY, FROM: from });
  const vd = holdoutVerdict(rows);
  console.log(`history starts: ${[...VERDICT_IDS].map((id) => `${id} ${closes(s[id] ?? [])[0]?.date ?? "—"}`).join(" · ")} · arm feeds: ${(["HCX", ...ARM_SERIES] as const).map((id) => `${id} ${s[id]?.[0]?.date ?? "—"}`).join(" · ")}`);
  console.log(`blind (verdict ids, legs read na): ${cov.blind.join(", ") || "—"} · partial: ${cov.partial.map((id) => `${id} ${cov.n[id]}`).join(", ") || "—"} (sparse throw exempt: ${SHALLOW.join(", ")})`);
  console.log(`${replayArg} ${from} → ${to} · baseline = pre-stack VALUE_RULES + LEGS_SHIPPED, no arms · signs [] (manual rows have no history; families read off closes) · exit = EU-Fin \`episodes\` over XDEV, fill = first close after it a third is ready\n${sweepTable(rows)}`);
  console.log(`worst bear ${pct(vd.worstBear)} vs ${pct(PASS.WORST_BEAR)} · worst fill trough ${pct(vd.worstFill)} vs ${pct(PASS.WORST_FILL_DROP)} → ${vd.pass ? "PASS" : "FAIL"} · ${vd.realBears} real bear(s)${vd.thin ? ` · THIN (${vd.bears} bear episodes)` : ""}`);
  console.log(`\narms vs baseline (B* alone, P* family ladders, S* stacked) · pass = worst bear ≥ ${pct(PASS.WORST_BEAR)} and every fill trough ≥ ${pct(PASS.WORST_FILL_DROP)}`);
  for (const a of VALUE_ARMS) {
    const ar = a === VALUE_ARMS[0] ? rows : replayValue(s, { ...REPLAY, FROM: from }, VALUE_RULES, a);
    const av = holdoutVerdict(ar);
    console.log(`${stopRow(a.name, ar)}  ${av.pass ? "PASS" : "FAIL"}  ${av.bears} bear / ${av.realBears} real${av.thin ? " · THIN" : ""}`);
    if (a.earn) {
      const ws = earnWindows(closes(s.MU_OPEN ?? []), closes(s.MU_CLOSE ?? [])).filter((w) => w.d >= from && w.d <= to);
      const fastAt = new Set(ws.filter((w) => w.fast).map((w) => closes(s.XDEV).find((p) => p.date > w.d1)?.date));
      console.log(`  ${a.name}: ${ws.length} MU reports in window · ${fastAt.size} fast reactions · ${ar.filter((e) => e.fills[1] !== null && fastAt.has(e.fills[1])).length} T2 fills on a fast close (${ar.filter((e, i) => e.fills[1] !== null && fastAt.has(e.fills[1]) && rows[i]!.fills[1] !== e.fills[1]).length} differ from baseline's)`);
    }
  }
  for (const a of VALUE_ARMS) console.log(`  ${a.name}: ${a.note}`);
}

const isMain = process.argv[1]?.endsWith("probe-value-tranches.ts") ?? false;
const base = (): string => process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl();
const replayArg = process.argv.find((a) => a.startsWith("--replay="))?.slice("--replay=".length);
if (isMain && replayArg !== undefined) await replayScorecard(base(), replayArg);
if (isMain && replayArg === undefined) {
  const into = process.argv.find((a) => a.startsWith("--into="))?.slice("--into=".length);
  const { existsSync, readFileSync } = await import("node:fs");
  const path = into ?? LADDER_LEGS.value.json;
  const today = isoDay(new Date());
  const live: LadderLive = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LadderLive) : { run: today, rules: [], signs: [], events: [], calendar: [], runs: [] };
  const s = await liveFetch(base());
  const { realFeeds } = await import("../src/feed-ports.js");
  const fred = (id: string) => realFeeds.fetchSeries(id, { now: new Date(), env: readEnv() });
  const measured = await measuredLifts(heldSigns(live.signs, allEvents(live)), fred);
  for (const n of measured.notes) console.warn(n);
  const result = evaluateShipped(s, live.signs, VALUE_RULES, LIVE_ARM, live.verdict, allEvents(live), today, measured.lifts);
  if (into !== undefined) {
    const [{ gatesText }, { writeInto }] = await Promise.all([import("../src/ladder-live.js"), import("./ladder-into.js")]);
    const prov = verdictProvisional(s);
    live.verdict = toVerdict(result, prov);
    const md = writeInto(into, live, "value");
    const tt = live.verdict.tranches.map((t) => `${t.id} ${t.met}/${t.total}${gatesText(t.gates)}`).join(" ");
    console.log(`wrote ${into}${md ? ` + ${md}` : ""} · ${tt} · box ${votesText(result.escalation)}${prov ? " · prov." : ""}`);
  } else if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(table(result, s));
  if (!process.argv.includes("--json")) {
    const phl = await fred("NOCDFSA066MSFRBPHI").then((o) => o.slice(-3).map((p) => `${p.value.toFixed(1)} (${p.date.slice(0, 7)})`).join(" · "), (e: Error) => `unread — ${e.message}`);
    console.log(`phl_orders (context, no family): Philly Fed new orders ${phl}`);
  }
}
