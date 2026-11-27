/**
 * EU-Fin fizzle-path re-entry (three tranches) over prod `/api/series` — read-only report, `--into=` writes `verdict` only
 * (+ re-renders `docs/eufin.md` on the canonical path, `ladder-into.ts`). Origin:
 * the EU-Fin re-entry levels research, re-cut scale-free on the held fund's own price and realized vol, plus the
 * AT1 relative; why → this file's commit message.
 */
import { reachOf, reviewedSigns } from "../src/ladder-block.js";
import { BOX_KERNEL, boxOf, type Cell, type Roster } from "../src/ladder-box.js";
import { extremeOf, lowSince, newExtreme, postShockLow, priorExt } from "../src/ladder-jobs.js";
import { allEvents, dpCell, familyRow, fixNum, gatesText, LEGS as LADDER_LEGS, makeTagOf, mmdd, probeTrancheCell, rvApart, rvn, vc, vcAt, vs, type LadderLive, type LadderAsOf, type LadderFamily, type LadderSign, type LadderVerdict, type ReadTag, type TaggedRead, type TrancheId, type Via } from "../src/ladder-live.js";
import { acceptance, BINDING, bindingTable, byDate, classifyBinding, closes, driftTable, episodes, fillDrift, fillDrops, HOLDOUT_WINDOW, holdoutVerdict, isFinal, PASS, pct, priceAt, eachSeries, fetchEach, knob, upTo, REPLAY, replayTotals, scoreEpisode, stopRow, sweepTable, v, whyTable, type BindingRow, type Episode, type EpisodeResult, type Pt, type ReplayKnobs, type WhyRow } from "./ladder-replay.js";
import { guardAnchor, hybridBreak, hybridCut, mean, openShockStart, sd } from "./ladder-shock.js";
import { boxHolds, boxStatus, cellsOf, clearedBox, cmp, shortOf, tick, votesText } from "./ladder-tranche.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";
export { boxHolds } from "./ladder-tranche.js";

// The shared replay core (`ladder-replay.ts`) owns `Pt` + `closes`; re-exported here for the probes and tests that read them off this leg.
export { closes, type Pt } from "./ladder-replay.js";

export const SERIES = ["AT1", "EXSH_GATE"] as const;
export type Id = (typeof SERIES)[number];
export type SeriesSet = Record<Id, Pt[]>;
/** Series id → the leg's ONE canonical indicator name (the `ReadTag.indicator` of every single-series row, `tagOf`); the spelling the md rows already print. */
export const INDICATOR: Record<Id, string> = { AT1: "AT1", EXSH_GATE: "EXSH" };
/** A row's read tag off its call site — the shared builder (`makeTagOf`, src/ladder-live.ts) over this leg's table. */
export const tagOf = makeTagOf(INDICATOR);

/** Every threshold lives here only. */
export const TRANCHE_RULES = {
  /** The sale; the time stop counts EXSH closes after it. */
  EXIT_DATE: "2026-10-01",
  /** Own-shock knobs no EU-Fin row reads now — the value leg's `KNOBS` (scripts/probe-value-tranches.ts) inherits them with SIGMA_N: base = median of BASE_N closes before the anchor; a shock opens on a close ≥ base + BROKE_SD × σ. */
  BASE_N: 20,
  BROKE_SD: 3,
  /** The pre-shock vol base = RV over this many closes before the drawdown opened (`volOf`). */
  SIGMA_N: 60,
  /** A new low = a close below every one of the prior HIGH_N closes. */
  HIGH_N: 20,
  /** Each tranche needs this many of its non-gate legs, capped at how many are live — the strict first tranche's 1 = all of them. */
  T1_NEED: 1,
  EXSH_FAST_MA: 20,
  T1_EXSH_N: 2,
  T2_NEED: 1,
  EXSH_MA: 50,
  EXSH_MA_BUFFER: 0.01,
  T2_PRICE_N: 5,
  /** The third tranche = the trend gate (EXSH > MA200, MA50 above its value MA_RISING_LAG closes back) + T3_NEED of the rest. */
  MA_RISING_LAG: 10,
  T3_NEED: 2,
  /** T1 also fires TIME_STOP_N closes after the exit while the escalation box stays clear. */
  TIME_STOP_N: 40,
  /** The box's member cut (`ruledCells`): AT1 at an ESC_AT1_LOW_N-close low in the last ESC_AT1_LOW_IN. */
  ESC_AT1_LOW_N: 60,
  ESC_AT1_LOW_IN: 5,
  /** The second / third tranche also fires this many closes after the tranche before them while their gates and the escalation box are clear; 0 = off. */
  T2_AFTER_N: 0,
  T3_AFTER_N: 0,
  /** Legs a tranche may leave unmet however many read n/a — `need` never exceeds the live legs less this (floor 1); 0 = NEED alone caps it. */
  NEED_SLACK: 0,
  /** Read by FAST_LEGS only: no new post-shock EXSH low and the ladder knobs below; the gate roster (`gates`) is read by BOTH sets. */
  T1_NO_LOW_N: 5,
  T2_NO_LOW_N: 15,
  /** Realized vol (EXSH): RV(RV_N) ≥ RV_OFF_PEAK under its post-shock peak and under RV(RV_N) RV_LAG closes back — or already at the second rung's level (T2_RV_MULT × base), so the first never trails it (unheld — a T1_HOLD_K > 0 hold still lags it). */
  RV_N: 10,
  RV_SLOW_N: 20,
  RV_OFF_PEAK: 0.2,
  RV_LAG: 5,
  /** Second rung: RV(RV_N) ≤ T2_RV_MULT × the pre-shock RV(SIGMA_N); third: RV(RV_SLOW_N) ≤ T3_RV_MULT × it. */
  T2_RV_MULT: 1.5,
  T3_RV_MULT: 1.2,
  /** The AT1 gate at T2/T3 ([USER] 2026-10-11): no new HIGH_N-close low of the XAT1/EXHA ratio in the latest N closes; n/a (passes) until AT1 holds over HIGH_N closes. */
  T2_AT1_GUARD_N: 10,
  T3_AT1_GUARD_N: 10,
  /** Fast-set arms, 0 = off (shipped). T1_MIX 1: the first tranche also needs a met credit-side AND a met equity-side family (a side with no live family is waived). */
  T1_MIX: 0,
  /** T1_HOLD_K > 0: a fast first-tranche family reads met only when met on ≥ T1_HOLD_K of the latest T1_HOLD_M EXSH closes. */
  T1_HOLD_K: 0,
  T1_HOLD_M: 5,
  /** Hybrid guards: the AT1 no-low guards break on `hybridBreak` while their own shock is open; false = rolling only. FAST_RULES inherits it. */
  HYBRID_GUARDS: false,
} as const;
export type Rules = { [K in keyof typeof TRANCHE_RULES]: (typeof TRANCHE_RULES)[K] extends string ? string : (typeof TRANCHE_RULES)[K] extends boolean ? boolean : number };

/** The set a close with EXSH at or above its MA200 is judged on: read with FAST_LEGS. */
export const FAST_RULES: Rules = {
  ...TRANCHE_RULES,
  /** k of the two families per tranche, T1_NEED ≤ T2_NEED ≤ T3_NEED (OQ3); NEED_SLACK short of all with some n/a. */
  NEED_SLACK: 1,
  T1_NEED: 1,
  TIME_STOP_N: 15,
  T2_NEED: 2,
  T2_AFTER_N: 10,
  T3_NEED: 2,
  T3_AFTER_N: 15,
};

export type Tranche = TrancheId;
export type Verdict = "met" | "unmet" | "na";
type Reading = { value: string; verdict: Verdict; count?: { got: number; need: number } };
export type LegResult = Reading & { key: string; tranche: Tranche; leg: string; rule: string; tip?: string; gate: boolean; live: Reading; tag: ReadTag };
export type TrancheResult = { tranche: Tranche; metCount: number; total: number; need: number; gates: Verdict[]; ready: boolean; clear: boolean; met: boolean; via?: Via; filled: boolean; since: string | null };

/** Consecutive closes back from the newest final row (the non-final tail — a provisional head, a lagging estimate — skipped) for which `ok(closes, i)` holds, capped at `need`; a non-final row between finals breaks it. */
export function streak(pts: Pt[], need: number, ok: (c: Pt[], i: number) => boolean): number {
  const rows = byDate(pts);
  while (rows.length && !isFinal(rows.at(-1)!)) rows.pop();
  const c = rows.filter(isFinal);
  let n = 0;
  for (let j = rows.length - 1, i = c.length - 1; j >= 0 && n < need; j--, i--) {
    if (!isFinal(rows[j]!) || !ok(c, i)) break;
    n++;
  }
  return n;
}

/** The latest-print view: estimated rows and the intraday (provisional) head read as closes. A stale provisional row mid-series stays non-final. */
export function livePrints(pts: Pt[]): Pt[] {
  const rows = byDate(pts);
  return rows.map((p, i) => (p.provisional && i < rows.length - 1 ? p : { ...p, provisional: null, estimated: null }));
}

/** The raw row the latest-print view heads on — its `estimated` flag intact (`livePrints` strips it). */
export function liveHeadRow(pts: Pt[]): Pt | undefined {
  const rows = byDate(pts);
  const lp = livePrints(pts);
  for (let i = lp.length - 1; i >= 0; i--) if (isFinal(lp[i]!)) return rows[i];
  return undefined;
}
/** An estimate head — a provisional one (the API may stamp both) is flagged by `(prov.)`, not ` est.`. */
const isEstHead = (h: Pt | undefined): boolean => h?.estimated === true && h.provisional !== true;
/** The verdict's `asOf` over the series `ids` it reads (both legs' probes); `est` only from heads ON `live` — a lagging estimate tags its own cell. */
export function asOfOf<I extends string>(s: Record<I, Pt[]>, ids: readonly I[]): LadderAsOf {
  const heads = ids.map((id) => liveHeadRow(s[id]));
  const live = heads.map((h) => h?.date ?? "").sort().at(-1) ?? "";
  return { close: ids.map((id) => closes(s[id]).at(-1)?.date ?? "").sort().at(-1) ?? "", live, est: heads.some((h) => h?.date === live && isEstHead(h)) };
}
/** A live reading: ` @MM-DD` when its oldest read heads before `at` (the verdict's `asOf.live` — the cell copies an older print), then ` est.` when any read heads on an estimate. */
export const estTagged = <I extends string, T extends { value: string }>(rd: T, s: Record<I, Pt[]>, reads: readonly I[], at: string): T => {
  const head = reads.map((id) => closes(livePrints(s[id])).at(-1)?.date ?? "").sort()[0];
  const dated = head && head < at ? { ...rd, value: `${rd.value} @${head.slice(5)}` } : rd;
  return reads.some((id) => isEstHead(liveHeadRow(s[id]))) ? { ...dated, value: `${dated.value} est.` } : dated;
};

const ma = (c: Pt[], i: number, n: number): number | null => (i >= n - 1 ? mean(c.slice(i - n + 1, i + 1).map((p) => p.value!)) : null);

const fmt = fixNum;

type Part = { id: Id; got: number; text: string; na?: boolean };

/** All non-n/a parts must reach `need`; the run shown is the weakest part's. A lone part prints without its id (the row label names it). */
function allOf(parts: Part[], need: number): Reading {
  const live = parts.filter((p) => !p.na);
  const value = parts.map((p) => `${parts.length > 1 ? `${p.id} ` : ""}${p.na ? "n/a" : p.text}`).join(" · ");
  if (live.length === 0) return { value, verdict: "na" };
  const got = Math.min(...live.map((p) => p.got));
  return { value, verdict: tick(got >= need), count: { got, need } };
}

/** Tip phrasing shared by the rules: a ×n run. */
const inARow = (n: number): string => (n === 1 ? "on the latest close" : `for ${n} closes in a row`);

const maRising = (c: Pt[], i: number, r: Rules): boolean => {
  const now = ma(c, i, r.EXSH_MA);
  const back = ma(c, i - r.MA_RISING_LAG, r.EXSH_MA);
  return now !== null && back !== null && now > back;
};
const maRisingTip = (r: Rules): string => `its ${r.EXSH_MA}-close average is above its value ${r.MA_RISING_LAG} closes back — the trend turned up.`;
/** The newest close against its MA200 (back out of `decision` = close / MA200 − 1) and the gap: `25.85/24.75 (+4.4%)`. */
const vsMa200 = (c: Pt[]): string => {
  const p = c.at(-1);
  const d = p?.decision;
  return p === undefined || d === null || d === undefined ? "—" : `${vc(p.value, p.value! / (1 + d))} (${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%)`;
};
const exshTrend = (c: Pt[], i: number, r: Rules): boolean => (c[i]!.decision ?? -1) > 0 && maRising(c, i, r);

/** Annualised (√252) sample sd of the n daily log returns ending at close i; null short of n + 1 closes or n < 2. */
export function realizedVol(c: Pt[], i: number, n: number): number | null {
  if (i < n || n < 2) return null;
  return sd(Array.from({ length: n }, (_, k) => Math.log(v(c, i - k) / v(c, i - k - 1)))) * Math.sqrt(252);
}

export type LegDef = { key: string; tranche: Tranche; gate?: boolean; side?: Side; leg: string; id: Id; /** The read schema (src/ladder-live.ts `ReadTag`): set at the row literal / factory call site (`tagOf`), copied onto the emitted row by `evaluate`. */ tag: ReadTag; /** Every series the reading reads, when more than `id` — the live `@MM-DD` tag keys on the oldest. */ reads?: Id[]; /** Short form only — knobs, never a series-derived value (those go in the reading), so close and live share it; `tip` = its what + why, same bar. */ rule: (r: Rules) => string; tip?: (r: Rules) => string; /** `signs` reaches the escalation-box gate row only (the live verdict's `signs[]`; `[]` on every replay walk — manual rows have no history). */ read: (r: Rules, s: SeriesSet, signs?: readonly SignLite[]) => Reading };

export type Side = "credit" | "equity";

const STRICT_CORE: LegDef[] = [
  {
    key: "t1-exsh-ma20",
    tag: tagOf({ series: ["EXSH_GATE"], job: "regime", agg: "kOfN" }),
    tranche: "T1",
    leg: `EXSH > MA${TRANCHE_RULES.EXSH_FAST_MA}`,
    id: "EXSH_GATE",
    rule: (r) => `> MA${r.EXSH_FAST_MA} ×${r.T1_EXSH_N}`,
    read: (r, s) => {
      const got = streak(s.EXSH_GATE, r.T1_EXSH_N, (c, i) => {
        const m = ma(c, i, r.EXSH_FAST_MA);
        return m !== null && v(c, i) > m;
      });
      const c = closes(s.EXSH_GATE);
      return { value: vc(c.at(-1)?.value, ma(c, c.length - 1, r.EXSH_FAST_MA)), verdict: tick(got >= r.T1_EXSH_N), count: { got, need: r.T1_EXSH_N } };
    },
  },
  {
    key: "t2-price",
    tag: tagOf({ series: ["EXSH_GATE"], job: "regime", agg: "kOfN" }),
    tranche: "T2",
    leg: "EXSH > MA50 +1%",
    id: "EXSH_GATE",
    rule: (r) => `EXSH > MA${r.EXSH_MA}·${knob(1 + r.EXSH_MA_BUFFER)} ×${r.T2_PRICE_N}`,
    read: (r, s) => {
      const exsh = streak(s.EXSH_GATE, r.T2_PRICE_N, (c, i) => {
        const m = ma(c, i, r.EXSH_MA);
        return m !== null && v(c, i) > m * (1 + r.EXSH_MA_BUFFER);
      });
      return allOf(
        [
          { id: "EXSH_GATE", got: exsh, text: ((c) => vc(c.at(-1)?.value, ((m) => (m === null ? null : m * (1 + r.EXSH_MA_BUFFER)))(ma(c, c.length - 1, r.EXSH_MA))))(closes(s.EXSH_GATE)) },
        ],
        r.T2_PRICE_N,
      );
    },
  },
  {
    key: "t3-trend",
    tag: tagOf({ series: ["EXSH_GATE"], job: "regime", agg: "allOf" }),
    tranche: "T3",
    gate: true,
    leg: "gate: EXSH > MA200, MA50 rising",
    id: "EXSH_GATE",
    rule: (r) => `> MA200, MA${r.EXSH_MA} rising`,
    tip: (r) => `EXSH closes above its 200-close average, and ${maRisingTip(r)}`,
    read: (r, s) => {
      const c = closes(s.EXSH_GATE);
      return { value: vsMa200(c), verdict: tick(c.length > 0 && exshTrend(c, c.length - 1, r)) };
    },
  },
];

/** A ×need run on one series, the newest close as its value. */
function run(s: SeriesSet, id: Id, need: number, ok: (c: Pt[], i: number) => boolean): Reading {
  const got = streak(s[id], need, ok);
  return { value: fmt(closes(s[id]).at(-1)?.value), verdict: tick(got >= need), count: { got, need } };
}

const DAY = 86_400_000;

/** Weekdays stepped from the earlier date to the later, counted no further than `cap + 1`. */
export function weekdaysApart(a: string, b: string, cap: number): number {
  const [lo, hi] = [a, b].sort().map((d) => Date.parse(d)) as [number, number];
  let n = 0;
  for (let t = lo + DAY; t <= hi && n <= cap; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) n++;
  return n;
}

const tkey = (t: Tranche, name: string): string => `${t.toLowerCase()}-${name}`;

const at1Guard = (tranche: Tranche, n: (r: Rules) => number, tag: ReadTag): LegDef => ({
  key: tkey(tranche, "at1-guard"),
  tag,
  tranche,
  gate: true,
  leg: "guard: AT1 no new low",
  id: "AT1",
  rule: (r) => `no ${r.HIGH_N}-close low ×${n(r)}`,
  read: (r, s) => {
    const c = closes(s.AT1);
    if (c.length <= r.HIGH_N) return NA;
    const at = guardAnchor(s.AT1, r.HYBRID_GUARDS);
    return allOf([{ id: "AT1", got: streak(s.AT1, n(r), (cc, i) => !(hybridBreak(cc, i, "low", at) ?? newExtreme(cc, i, r.HIGH_N, "low", { guard: true }))), text: vcAt(c.at(-1)?.value, hybridCut(c, "low", at) ?? priorExt(c, r.HIGH_N, "low"), 4) }], n(r));
  },
});

/** The box as the last gate row of every tranche: `boxHolds` — `tally` holds the same guard, so the row and the verdict never disagree. One rule text for all three (the quorum clause is prefixed `T2·T3:`), so the row renders once under shared gates until the readings differ. */
const escLeg = (tranche: Tranche, tag: ReadTag): LegDef => ({
  key: tkey(tranche, "esc"),
  tag,
  tranche,
  gate: true,
  leg: "gate: escalation box",
  id: "AT1",
  reads: ["AT1"],
  rule: () => `no veto · T2·T3: live ≥ ${Math.round(BOX_KERNEL.QUORUM_SHARE * 100)}%`,
  tip: () => `Cluster ${CLUSTERS.map((c) => `${c.name} (${c.kind})`).join(" · ")} votes on a strict majority of its live members — shown, it holds nothing alone; a block on ${VETO_ROWS.join(" / ")} holds every tranche; below quorum T2/T3 hold too.`,
  read: (r, s, signs) => ((e) => ({ value: votesText(e), verdict: tick(!boxHolds(tranche, e)) }))(escalation(s, r, signs)),
});

/** The gate roster BOTH sets spread per tranche — edit a gate here only. Every roster ends on the escalation box. The deciding-event calendar is not a gate: `afterHolds` (src/ladder-run.ts) holds a tranche until each of its `events[].holds` rows lands `fizzle:` (an `escalation:` outcome keeps holding). */
const AT1_GUARD = tagOf({ series: ["AT1"], job: "relative", agg: "allOf" });
/** Each member's series — `ruledReads` reads it, the member tag's `series` is it, its live head dates and est.-tags the member's `live` text. */
const MEMBER_SERIES: Record<Member, Id> = { at1: "AT1" };
/** The box row reads the cluster members (`ruledCells`, series = `MEMBER_SERIES`) against the veto rows and the quorum — ≥ 2 comparands, so `composite`. */
const ESC_GATE = tagOf({ series: Object.values(MEMBER_SERIES), job: "composite", agg: "allOf", indicator: "escalation box" });
const gates = (t: Tranche): LegDef[] =>
  t === "T1"
    ? [escLeg("T1", ESC_GATE)]
    : t === "T2"
      ? [at1Guard("T2", (r) => r.T2_AT1_GUARD_N, AT1_GUARD), escLeg("T2", ESC_GATE)]
      : [at1Guard("T3", (r) => r.T3_AT1_GUARD_N, AT1_GUARD), escLeg("T3", ESC_GATE)];

export const LEGS: LegDef[] = [...STRICT_CORE, ...gates("T1"), ...gates("T2"), ...gates("T3")];

/** a ∧ b — a n/a → n/a · b n/a → a · else met iff both, reading the binding part. */
export function nest(prev: Reading, next: Reading): Reading {
  if (prev.verdict === "na" || next.verdict === "na") return prev;
  return { ...(prev.verdict === "unmet" ? prev : next), verdict: tick(prev.verdict === "met" && next.verdict === "met") };
}

/** Two sibling tests ANDed symmetrically — both n/a → n/a · one n/a → the other · else met iff both, reading the binding part. */
export const both = (a: Reading, b: Reading): Reading => (a.verdict === "na" ? b : b.verdict === "na" ? a : nest(a, b));

/** A test naming its own `id` reads its own series (the live tag follows them); `label` renames the rung when that is fewer than the family name implies. */
type Test = Pick<LegDef, "rule" | "read" | "tag"> & Partial<Pick<LegDef, "id" | "reads" | "tip">> & { label?: string };

/** A family's next rung: its own test alone, keyed after the rung below — never ANDed with it, so each row reads as its own criterion. */
const rung = (prev: LegDef, next: Test): LegDef => {
  const tranche = prev.tranche === "T1" ? "T2" : "T3";
  const own = next.id === undefined ? prev : next;
  return { ...prev, key: tkey(tranche, prev.key.slice(3)), tranche, leg: next.label ?? prev.leg, id: own.id!, reads: own.reads, rule: next.rule, tip: next.tip, read: next.read, tag: next.tag };
};

const ladder = (t1: LegDef, t2: Test, t3: Test): [LegDef, LegDef, LegDef] => {
  const l2 = rung(t1, t2);
  return [t1, l2, rung(l2, t3)];
};

type Vol = { c: Pt[]; i: number; now: number; peak: number; peakDate: string; base: number | null };

/** EXSH RV(RV_N) now, its peak since the open EXSH drawdown's shock start (`openShockStart`), and the baseline RV over the SIGMA_N returns before that anchor — null with no open drawdown. */
function volOf(s: SeriesSet, r: Rules): Vol | null {
  const c = closes(s.EXSH_GATE);
  const i = c.length - 1;
  const start = openShockStart(c);
  const first = start === null ? -1 : c.findIndex((p) => p.date >= start);
  const now = realizedVol(c, i, r.RV_N);
  if (first === -1 || now === null) return null;
  let [peak, peakDate] = [now, c[i]!.date];
  for (let k = first; k < i; k++) if ((realizedVol(c, k, r.RV_N) ?? 0) > peak) [peak, peakDate] = [realizedVol(c, k, r.RV_N)!, c[k]!.date];
  return { c, i, now, peak, peakDate, base: realizedVol(c, first - 1, r.SIGMA_N) };
}

const NA: Reading = { value: "—", verdict: "na" };
const vsBase = (r: Rules, s: SeriesSet, n: number, mult: number): Reading => {
  const x = volOf(s, r);
  const now = x && realizedVol(x.c, x.i, n);
  if (!x || now === null) return NA;
  const cut = x.base === null ? null : mult * x.base;
  const w = rvApart(now, [cut]);
  const value = `${rvn(now, w)}/${rvn(cut, w)}`;
  return x.base === null ? { ...NA, value } : { value, verdict: tick(now <= mult * x.base) };
};
const vsBaseRule = (n: number, mult: number): string => `RV${n} ≤ ${mult}× base`;
const rvTip = (r: Rules, n: number): string => `RV${n} = EXSH's annualised ${n}-close realized vol; base = its RV over the ${r.SIGMA_N} closes before the drawdown's shock start.`;
const vsBaseTip = (r: Rules, n: number, mult: number): string => `${rvTip(r, n)} Needs RV${n} ≤ ${mult}× base on the latest close — equity vol back near its pre-shock norm.`;

const VOL_LADDER = ladder(
  {
    key: "t1-vol",
    // RV vs its post-shock peak, vs its value RV_LAG closes back, vs the pre-shock base — ≥ 2 comparands.
    tag: tagOf({ series: ["EXSH_GATE"], job: "composite", agg: "kOfN" }),
    tranche: "T1",
    side: "equity",
    leg: "vol EXSH realized",
    id: "EXSH_GATE",
    rule: (r) => `RV${r.RV_N} fading, or ≤ ${r.T2_RV_MULT}× base`,
    tip: (r) => `${rvTip(r, r.RV_N)} Fading = ≥ ${knob(r.RV_OFF_PEAK * 100)}% under its post-shock peak and below its value ${r.RV_LAG} closes back; or already ≤ ${r.T2_RV_MULT}× base.`,
    read: (r, s) => {
      const x = volOf(s, r);
      if (x === null) return NA;
      const lag = realizedVol(x.c, x.i - r.RV_LAG, r.RV_N);
      const [offPeak, under, base] = [(1 - r.RV_OFF_PEAK) * x.peak, lag, x.base === null ? null : r.T2_RV_MULT * x.base];
      const ok = [x.now <= offPeak, under !== null && x.now < under, base !== null && x.now <= base] as const;
      const w = rvApart(x.now, [offPeak, under, base]);
      const value = `${rvn(x.now, w)} ${cmp("≤", `${rvn(offPeak, w)} (${rvn(x.peak)} ${mmdd(x.peakDate)})`, ok[0])} ${cmp("<", `${rvn(under, w)}${under === null ? "" : ` (${mmdd(x.c[x.i - r.RV_LAG]!.date)})`}`, ok[1])} | ${cmp("≤", rvn(base, w), ok[2])}`;
      return { value, verdict: tick(ok[2] || (ok[0] && ok[1])) };
    },
  },
  { tag: tagOf({ series: ["EXSH_GATE"], job: "recovery", agg: "kOfN" }), rule: (r) => vsBaseRule(r.RV_N, r.T2_RV_MULT), tip: (r) => vsBaseTip(r, r.RV_N, r.T2_RV_MULT), read: (r, s) => vsBase(r, s, r.RV_N, r.T2_RV_MULT) },
  { tag: tagOf({ series: ["EXSH_GATE"], job: "recovery", agg: "kOfN" }), rule: (r) => vsBaseRule(r.RV_SLOW_N, r.T3_RV_MULT), tip: (r) => vsBaseTip(r, r.RV_SLOW_N, r.T3_RV_MULT), read: (r, s) => vsBase(r, s, r.RV_SLOW_N, r.T3_RV_MULT) },
);
const noLowRule = (n: number): string => `no post-shock low ×${n}`;
const noLowTip = (name: string, n: number): string => `${name} closes above its lowest close since the drawdown opened ${inARow(n)} — the sell-off no longer making new lows.`;
/** The lowest close since `since` before the newest (+ its date) — the line a post-shock low crosses. */
const lowRun = (s: SeriesSet, r: Rules, id: Id, n: number): Reading => ({ ...run(s, id, n, (c, i) => !postShockLow(c, i, r.EXIT_DATE)), value: ((c) => vcAt(c.at(-1)?.value, lowSince(c, r.EXIT_DATE)))(closes(s[id])) });
const noLow = (s: SeriesSet, r: Rules, n: number): Reading => lowRun(s, r, "EXSH_GATE", n);
const PRICE_LADDER = ladder(
  { key: "t1-price", tag: tagOf({ series: ["EXSH_GATE"], job: "recovery", agg: "kOfN" }), tranche: "T1", side: "equity", leg: "price EXSH", id: "EXSH_GATE", rule: (r) => noLowRule(r.T1_NO_LOW_N), tip: (r) => noLowTip("EXSH", r.T1_NO_LOW_N), read: (r, s) => noLow(s, r, r.T1_NO_LOW_N) },
  { tag: tagOf({ series: ["EXSH_GATE"], job: "recovery", agg: "kOfN" }), rule: (r) => noLowRule(r.T2_NO_LOW_N), tip: (r) => noLowTip("EXSH", r.T2_NO_LOW_N), read: (r, s) => noLow(s, r, r.T2_NO_LOW_N) },
  {
    tag: tagOf({ series: ["EXSH_GATE"], job: "regime", agg: "kOfN" }),
    rule: (r) => `> MA${r.EXSH_MA}, MA${r.EXSH_MA} rising`,
    tip: (r) => `EXSH closes above its ${r.EXSH_MA}-close average, and ${maRisingTip(r)}`,
    read: (r, s) => {
      const c = closes(s.EXSH_GATE);
      const i = c.length - 1;
      const m = ma(c, i, r.EXSH_MA);
      if (i < 0) return NA;
      const ok = [m !== null && v(c, i) > m, maRising(c, i, r)] as const;
      const back = i >= r.MA_RISING_LAG ? c[i - r.MA_RISING_LAG]! : null;
      const bm = back && ma(c, i - r.MA_RISING_LAG, r.EXSH_MA);
      // The MA prints twice: one width for the close, the MA and its lagged self.
      const w = Math.max(dpCell([[v(c, i), m]]), dpCell([[m, bm]], 3));
      const [[px, mp], [mn, mb]] = [vs(v(c, i), m, w), vs(m, bm, w)];
      return { value: `${px} ${cmp(">", `MA${r.EXSH_MA} ${mp}`, ok[0])} · MA${r.EXSH_MA} ${mn} ${cmp(">", `${mb}${back ? ` (${mmdd(back.date)})` : ""}`, ok[1])}`, verdict: tick(ok[0] && ok[1]) };
    },
  },
);

/** The two families, each one rung per tranche, in recovery order. */
const FAMILIES: LegDef[][] = [VOL_LADDER, PRICE_LADDER];
const rungs = (k: 0 | 1 | 2): LegDef[] => FAMILIES.map((f) => f[k]!);

/** T1_HOLD_K > 0: met only on ≥ K of the latest T1_HOLD_M EXSH closes (the latest included); n/a stays n/a. */
export const held = (d: LegDef): LegDef => ({
  ...d,
  read: (r, s) => {
    const now = d.read(r, s);
    if (r.T1_HOLD_K <= 0 || now.verdict === "na") return now;
    const days = closes(s.EXSH_GATE).slice(-r.T1_HOLD_M).map((p) => p.date);
    const got = days.filter((day, i) => (i === days.length - 1 ? now : d.read(r, truncate(s, day))).verdict === "met").length;
    return { ...now, verdict: tick(got >= r.T1_HOLD_K), count: { got, need: r.T1_HOLD_K } };
  },
});

export const FAST_LEGS: LegDef[] = [
  ...rungs(0).map(held),
  ...gates("T1"),
  ...rungs(1),
  ...gates("T2"),
  {
    key: "t3-trend",
    tag: tagOf({ series: ["EXSH_GATE"], job: "regime", agg: "allOf" }),
    tranche: "T3",
    gate: true,
    leg: "gate: EXSH > MA200",
    id: "EXSH_GATE",
    rule: () => "close > MA200",
    read: (_r, s) => {
      const c = closes(s.EXSH_GATE);
      return { value: vsMa200(c), verdict: tick((c.at(-1)?.decision ?? -1) > 0) };
    },
  },
  ...rungs(2),
  ...gates("T3"),
];

/** Arm: bank credit as a 5th first-tranche family — AT1 no post-exit low ×T1_NO_LOW_N; n/a until AT1 holds a close before EXIT_DATE. */
const at1T1: LegDef = {
  key: "t1-at1",
  tag: tagOf({ series: ["AT1"], job: "recovery", agg: "kOfN" }),
  tranche: "T1",
  side: "credit",
  leg: "bank credit AT1",
  id: "AT1",
  rule: (r) => `AT1 ${noLowRule(r.T1_NO_LOW_N)}`,
  tip: (r) => noLowTip("AT1", r.T1_NO_LOW_N),
  read: (r, s) => (closes(s.AT1).some((p) => p.date < r.EXIT_DATE) ? lowRun(s, r, "AT1", r.T1_NO_LOW_N) : NA),
};
export const FAST_LEGS_AT1: LegDef[] = FAST_LEGS.flatMap((d) => (d.key === FAMILIES.at(-1)![0]!.key ? [d, held(at1T1)] : [d]));

/** The T1 arms the holdouts read side by side (`--t1-arms`); none changes FAST_RULES. */
export const T1_ARMS: { name: string; at: Partial<Rules>; defs: LegDef[] }[] = [
  { name: "shipped", at: {}, defs: FAST_LEGS },
  { name: "P3 credit+equity", at: { T1_MIX: 1 }, defs: FAST_LEGS },
  { name: "P4 held 3/5", at: { T1_HOLD_K: 3, T1_HOLD_M: 5 }, defs: FAST_LEGS },
  { name: "P5 AT1 need 1", at: {}, defs: FAST_LEGS_AT1 },
  { name: "P5 AT1 need 2", at: { T1_NEED: 2 }, defs: FAST_LEGS_AT1 },
];

/** The four sign-row fields the box reads (`blocked` for a demoted veto's reach) — `public/eufin.json` `signs[]` rows (`LadderSign`) or a test's. */
export type SignLite = Pick<LadderSign, "sign" | "lean" | "block"> & Partial<Pick<LadderSign, "blocked">>;
/** `boxOf` over `CLUSTERS`: `tripped`/`hits` = the voting clusters, `need` = one per kind; `families` = the Episode gates rows in `ESC_FAMILIES` order (`familyRow`), display only. */
export type Escalation = { tripped: number; need: number; hits: string[]; families: LadderFamily[] } & Required<Pick<LadderVerdict["escalation"], "clusters" | "veto" | "quorum">> & { hold: boolean; holdT2T3: boolean };
/** The Episode-gates family rows — shown, never voted; a row duplicating a `CLUSTERS` member is that member, never a family. */
export const ESC_FAMILIES = ["bank actions", "sovereign events"] as const;
export type EscFamily = (typeof ESC_FAMILIES)[number];
/** Each box row's sign rows, by their `signs[].sign` string: a family's `block` unmeets it, a member carries them (`signs`); a string outside this table lands nowhere (its block still holds through `VETO_ROWS`). */
const SIGN_TABLE = {
  at1: ["Single-institution stress"],
  "bank actions": ["Bank / insurer windfall taxes", "Supervisors pressuring dividends / buybacks", "Earnings revisions / guidance tone", "Insurer lapse / sovereign-holding risk"],
  "sovereign events": ["Budget votes, 49.3, no-confidence", "Rating reviews (FR / IT / UK)", "Sovereign–bank doom loop", "ECB backstop (TPI)", "UK fiscal event"],
} as const satisfies Record<EscFamily | Member, readonly string[]>;
export const FAMILY_SIGN: Record<EscFamily | Member, readonly string[]> = SIGN_TABLE;
export type SignId = (typeof SIGN_TABLE)[EscFamily | Member][number];
/** Each family's read tag (`familyRow` opts.tag): both read off their sign rows alone (`manual`, the box tag). */
export const FAMILY_TAG: Record<EscFamily, ReadTag> = {
  "bank actions": { indicator: "bank actions", series: [], job: "manual", agg: "box" },
  "sovereign events": { indicator: "sovereign events", series: [], job: "manual", agg: "box" },
};
/** Every static read the leg emits, for `duplicateReads` / `scripts/lint-ladder-reads.ts`: the strict roster (`LEGS`) + the box families (key = name); `FAST_TAGGED_READS` = the same over the fast roster, the set the verdict reads today. */
export const TAGGED_READS: readonly TaggedRead[] = [...LEGS, ...ESC_FAMILIES.map((f) => ({ key: f, tag: FAMILY_TAG[f] }))];
export const FAST_TAGGED_READS: readonly TaggedRead[] = [...FAST_LEGS, ...ESC_FAMILIES.map((f) => ({ key: f, tag: FAMILY_TAG[f] }))];

/** The box roster (`boxOf`); never in `LADDER_LEGS` or the leg JSON. */
export const CLUSTERS = [{ name: "credit", kind: "coincident", members: ["at1"] }] as const satisfies Roster<"at1">;
export type Member = (typeof CLUSTERS)[number]["members"][number];
/** Core-driver BLOCK rows: one holds every tranche alone (`reachOf` over an `"all"` leg — no measured half grades it); every other row's block casts no vote. */
export const VETO_ROWS = ["Supervisors pressuring dividends / buybacks", "Single-institution stress"] as const satisfies readonly SignId[];
/** Each member's read tag (`escalation` copies it onto the member); `series` = `MEMBER_SERIES`, never re-typed. */
const MEMBER_TAG: Record<Member, ReadTag> = {
  at1: tagOf({ series: [MEMBER_SERIES.at1], job: "relative", agg: "box" }),
};
/** A member's cell + its Episode gates text: `rule` off the rules, `value` = the read the cell judged. */
export type MemberRead = { cell: Cell; rule: string; value: string };
const NO_HISTORY = "no history";
/** Each member's ruled read; `none` = its series has no close on or before the read date (every read site truncates to it). */
export function ruledReads(s: SeriesSet, r: Rules): Record<Member, MemberRead> {
  const EPS = 1e-9;
  const hit = (ok: boolean): Cell => (ok ? "hit" : false);
  const of = (id: Id): number[] => closes(s[id]).map((p) => p.value!);
  const at1 = of(MEMBER_SERIES.at1);
  const atLow = (i: number): boolean => at1[i]! <= Math.min(...at1.slice(i - r.ESC_AT1_LOW_N + 1, i + 1)) + EPS;
  const at1Cell: Cell = !at1.length ? "none" : at1.length < r.ESC_AT1_LOW_N + r.ESC_AT1_LOW_IN - 1 ? "na" : hit(Array.from({ length: r.ESC_AT1_LOW_IN }, (_, k) => at1.length - 1 - k).some(atLow));
  const lowAgo = Array.from({ length: r.ESC_AT1_LOW_IN }, (_, k) => k).find((k) => at1Cell === "hit" && atLow(at1.length - 1 - k));
  const at1Text = at1Cell === "none" ? NO_HISTORY : at1Cell === "na" ? shortOf(r.ESC_AT1_LOW_N + r.ESC_AT1_LOW_IN - 1) : lowAgo !== undefined ? `${r.ESC_AT1_LOW_N}-close low ${lowAgo ? `${lowAgo} close${lowAgo > 1 ? "s" : ""} ago` : "on the latest close"}` : vcAt(at1.at(-1), extremeOf(closes(s[MEMBER_SERIES.at1]).slice(-r.ESC_AT1_LOW_N), "low"), 4);
  return {
    at1: { cell: at1Cell, rule: `AT1 RS at a ${r.ESC_AT1_LOW_N}-close low in the last ${r.ESC_AT1_LOW_IN}`, value: `AT1 RS ${at1Text}` },
  };
}
/** `ruledReads`' cells. */
export const ruledCells = (s: SeriesSet, r: Rules): Record<Member, Cell> => cellsOf(ruledReads(s, r));

/** The box (`boxOf` over `ruledCells`, a VETO_ROWS block vetoes) + the bank-actions row off its sign rows alone; its `block: true` sign row unmeets it. */
export function escalation(s: SeriesSet, r: Rules, signs: readonly SignLite[] = []): Escalation {
  const signsOf = (f: EscFamily | Member): SignLite[] => FAMILY_SIGN[f].flatMap((id) => signs.filter((g) => g.sign === id)).map(({ sign, lean, block }) => ({ sign, lean, block }));
  const families = ESC_FAMILIES.map((f) => familyRow(f, "a block sign", null, signsOf(f), { tag: FAMILY_TAG[f] }));
  const ruled = ruledReads(s, r);
  const box = boxOf(CLUSTERS, cellsOf(ruled), VETO_ROWS.filter((id) => signs.some((g) => g.sign === id && g.block)).map((name) => ({ name, reach: reachOf(false, LADDER_LEGS.eufin.blockReach, signs.find((g) => g.sign === name)?.blocked?.reach) })));
  const clusters = box.clusters.map((c) => ({ ...c, members: c.members.map((m) => ({ ...m, rule: ruled[m.id as Member].rule, value: ruled[m.id as Member].value, tag: MEMBER_TAG[m.id as Member], ...((g) => (g.length ? { signs: g } : {}))(signsOf(m.id as Member)) })) }));
  return { tripped: box.votes.length, need: new Set(CLUSTERS.map((c) => c.kind)).size, hits: box.votes, families, clusters, veto: box.veto, quorum: { live: box.live, n: box.n, need: box.quorum, t1Only: box.t1Only }, hold: box.hold, holdT2T3: box.holdT2T3 };
}

const sessionsSinceExit = (s: SeriesSet, r: Rules): number => closes(s.EXSH_GATE).filter((p) => p.date > r.EXIT_DATE).length;

type Raw = { tranche: Tranche; metCount: number; total: number; need: number; gates: Verdict[]; ready: boolean; clear: boolean; via?: Via };

function tally(legs: (Reading & { tranche: Tranche; gate: boolean; side?: Side })[], r: Rules, esc: Escalation, sinceExit: number): Raw[] {
  const needOf = { T1: r.T1_NEED, T2: r.T2_NEED, T3: r.T3_NEED };
  return (["T1", "T2", "T3"] as const).map((t): Raw => {
    const mine = legs.filter((l) => l.tranche === t && l.verdict !== "na");
    const gates = mine.filter((l) => l.gate);
    const rest = mine.filter((l) => !l.gate);
    const metCount = rest.filter((l) => l.verdict === "met").length;
    const need = Math.min(needOf[t], Math.max(rest.length - r.NEED_SLACK, 1));
    const clear = gates.every((l) => l.verdict === "met") && !boxHolds(t, esc);
    const sides = new Set(rest.flatMap((l) => (l.side ? [l.side] : [])));
    const mixed = t !== "T1" || !r.T1_MIX || [...sides].every((sd) => rest.some((l) => l.side === sd && l.verdict === "met"));
    const legsReady = gates.every((l) => l.verdict === "met") && metCount >= need && mine.length > 0 && mixed;
    const timeStop = t === "T1" && clear && sinceExit >= r.TIME_STOP_N;
    const gateVerdicts = legs.filter((l) => l.tranche === t && l.gate).map((l) => l.verdict);
    return { tranche: t, metCount, total: rest.length, need, gates: gateVerdicts, ready: legsReady || timeStop, clear, ...(!legsReady && timeStop && { via: "time stop" as const }) };
  });
}

const truncate = (s: SeriesSet, d: string): SeriesSet => eachSeries(SERIES, s, upTo(d));

type RawLeg = Reading & { tranche: Tranche; gate: boolean; side?: Side };
const legsAt = (s: SeriesSet, r: Rules, defs: LegDef[], signs: readonly SignLite[] = []): RawLeg[] => defs.map((d) => ({ tranche: d.tranche, gate: d.gate ?? false, ...(d.side && { side: d.side }), ...d.read(r, s, signs) }));

function rawAt(s: SeriesSet, r: Rules, defs: LegDef[] = LEGS, signs: readonly SignLite[] = []): { legs: RawLeg[]; raw: Raw[] } {
  const legs = legsAt(s, r, defs, signs);
  return { legs, raw: tally(legs, r, escalation(s, r, signs), sessionsSinceExit(s, r)) };
}

/** Tranche k fires at `d` on its own legs + gates, whatever the tranches before it hold — or, the one before it
 *  filled, T2_AFTER_N / T3_AFTER_N of the closes `c` after that fill while clear. */
function fires(t: Raw, k: number, reached: (string | null)[], d: string, r: Rules, c: Pt[]): boolean {
  if (t.ready) return true;
  const prior = k === 0 ? null : (reached[k - 1] ?? null);
  const n = k === 1 ? r.T2_AFTER_N : r.T3_AFTER_N;
  return prior !== null && n > 0 && t.clear && c.filter((p) => p.date > prior && p.date <= d).length >= n;
}

/** The first close each tranche fires at, each independently; only the AFTER_N time path reads the fill before it. */
function cascade(raw: Raw[], reached: (string | null)[], d: string, r: Rules, c: Pt[]): (string | null)[] {
  const out = [...reached];
  raw.forEach((t, k) => {
    if (out[k] === null && fires(t, k, out, d, r, c)) out[k] = d;
  });
  return out;
}

export const liveSet = (s: SeriesSet): SeriesSet => Object.fromEntries(SERIES.map((id) => [id, livePrints(s[id])])) as SeriesSet;

/** Pure: closes give the verdict; the latest-print view (`livePrints`) gives each leg's `live`, tallied apart in `tranchesLive`.
 *  `signs` (the live `signs[]` rows) reach the box on the latest close and the live view only — the forward walk reads `[]`, manual rows having no history. */
export function evaluate(s: SeriesSet, r: Rules = TRANCHE_RULES, defs: LegDef[] = LEGS, walk: (t: SeriesSet, d: string) => { r: Rules; defs: LegDef[] } = () => ({ r, defs }), signs: readonly SignLite[] = []) {
  const live = liveSet(s);
  const exsh = closes(s.EXSH_GATE);
  const asOf = asOfOf(s, SERIES);
  const dated = <T extends { value: string }>(rd: T, reads: Id[]): T => estTagged(rd, s, reads, asOf.live);
  const legs = defs.map((d): LegResult => ({ key: d.key, tranche: d.tranche, gate: d.gate ?? false, leg: d.leg, rule: d.rule(r), tag: d.tag, ...(d.tip && { tip: d.tip(r) }), ...d.read(r, s, signs), live: dated(d.read(r, live, signs), d.reads ?? [d.id]) }));
  let reached: (string | null)[] = [null, null, null];
  for (const d of exsh.filter((p) => p.date > r.EXIT_DATE).map((p) => p.date)) {
    const t = truncate(s, d);
    const w = walk(t, d);
    reached = cascade(rawAt(t, w.r, w.defs).raw, reached, d, w.r, exsh);
  }
  const now = rawAt(s, r, defs, signs).raw;
  const nowDate = SERIES.map((id) => closes(s[id]).at(-1)?.date ?? "").sort().at(-1)!;
  reached = cascade(now, reached, nowDate, r, exsh);
  const liveRaw = rawAt(live, r, defs, signs).raw;
  const liveDate = byDate(live.EXSH_GATE).at(-1)?.date ?? "";
  const liveExsh = closes(live.EXSH_GATE);
  const liveReached = cascade(liveRaw, reached, liveDate, r, liveExsh);
  const esc = escalation(s, r, signs);
  const liveReads = ruledReads(live, r);
  const result = (raw: Raw[], reach: (string | null)[], d: string, c: Pt[]): TrancheResult[] =>
    raw.map((t, k) => {
      const met = fires(t, k, reach, d, r, c);
      return { ...t, met, ...(met && !t.ready && { via: (k === 1 ? "after T1" : "after T2") }), since: reach[k] ?? null, filled: reach[k] !== null && reach[k] !== undefined };
    });
  return {
    legs,
    asOf,
    tranches: result(now, reached, nowDate, exsh),
    tranchesLive: result(liveRaw, liveReached, liveDate, liveExsh),
    escalation: { ...esc, clusters: esc.clusters.map((c) => ({ ...c, members: c.members.map((m) => ({ ...m, live: dated({ value: liveReads[m.id as Member].value }, [MEMBER_SERIES[m.id as Member]]).value, liveCell: liveReads[m.id as Member].cell })) })) },
    sessionsSinceExit: sessionsSinceExit(s, r),
  };
}

/** The replay cut's first date: PRE_DAYS before the episode's price shock (`Episode.shockStart`). */
const cutFrom = (shockStart: string, k: ReplayKnobs = REPLAY): string => isoDay(new Date(Date.parse(shockStart) - k.PRE_DAYS * DAY));

/** First-fired close per tranche strictly after the exit; series cut to dates ≥ `from` (`cutFrom`; "" = uncut). */
export function replayFills(s: SeriesSet, r: Rules, end: string, defs: LegDef[] = LEGS, from = ""): (string | null)[] {
  const cut = Object.fromEntries(SERIES.map((id) => [id, s[id].filter((p) => p.date >= from && p.date <= end)])) as SeriesSet;
  let reached: (string | null)[] = [null, null, null];
  const exsh = closes(cut.EXSH_GATE);
  for (const d of exsh.filter((p) => p.date > r.EXIT_DATE).map((p) => p.date)) reached = cascade(rawAt(truncate(cut, d), r, defs).raw, reached, d, r, exsh);
  return reached;
}

const ALWAYS_T1: LegDef = { key: "t1-always", tag: { indicator: "always", series: [], job: "manual", agg: "kOfN" }, tranche: "T1", leg: "always met", id: "EXSH_GATE", reads: [], rule: () => "—", read: () => ({ value: "—", verdict: "met" }) };

/** Per episode on the fast set + the shipped escalation form: T1's fill (`t1Legs` = on its legs alone, no time stop) vs the first close tranche 2's own legs are met (T1 always met, T2_AFTER_N 0); `early` = those legs met before T1 fills, or T1 never fills. */
export function orderReplay(s: SeriesSet, k: ReplayKnobs = REPLAY, base: Rules = { ...FAST_RULES, ...SHIPPED_ARM.esc }, defs: LegDef[] = FAST_LEGS): (Episode & { t1: string | null; t1Legs: string | null; t2: string | null; early: boolean })[] {
  return episodes(s.EXSH_GATE, k).map((e) => {
    const r = { ...base, EXIT_DATE: e.exit, T2_AFTER_N: 0 };
    const from = cutFrom(e.shockStart);
    const t1 = replayFills(s, r, e.end, defs, from)[0]!;
    const t1Legs = replayFills(s, { ...r, TIME_STOP_N: Infinity }, e.end, defs, from)[0]!;
    const t2 = replayFills(s, r, e.end, [ALWAYS_T1, ...defs.filter((d) => d.tranche !== "T1")], from)[1]!;
    return { ...e, t1, t1Legs, t2, early: t2 !== null && (t1 === null || t2 < t1) };
  });
}

/** `scoreEpisode` over EXSH_GATE per `episodes` exit, `replayFills` from the shock start. */
export function replay(s: SeriesSet, base: Rules = TRANCHE_RULES, defs: LegDef[] = LEGS, k: ReplayKnobs = REPLAY): EpisodeResult[] {
  return episodes(s.EXSH_GATE, k).map((e) => {
    const fills = replayFills(s, { ...base, EXIT_DATE: e.exit }, e.end, defs, cutFrom(e.shockStart));
    return scoreEpisode(s.EXSH_GATE, e, fills);
  });
}

/** The fund's closes as an EXSH_GATE series: value = close, decision = close / MA200 − 1. */
/** The arm cuts, fixed before the first arm run. */
export const ARM = {
  STOP: [0.02, 0.05],
  /** `Arm.fillStop` cut under the fill close; fixed before the first read. */
  BEAR_STOP: 0.04,
  /** A stop arm's in-sample all-total may trail shipped's by at most this (`--replay=sweep --stop-arms`). */
  STOP_ALL_SLACK: 0.05,
  /** A monthly HICP point is read this many days after its reference date. */
  HICP_LAG_DAYS: 45,
  /** The fast set takes over only once EXSH has closed at or above its MA200 on each of the latest N closes. */
  MA200_CONFIRM_N: 3,
  /** Aliases of the shared `PASS` (ladder-replay.ts) — the one source of the pass cuts. */
  PASS_WORST_BEAR: PASS.WORST_BEAR,
  PASS_WORST_FILL_DROP: PASS.WORST_FILL_DROP,
} as const;

export const SWITCHES = ["none", "exsh-ma200", "epath-hicp"] as const;
export type SwitchKey = (typeof SWITCHES)[number];
export type Extra = { EPATH: Pt[]; HICP: Pt[] };
/** `fillStop`: every tranche sold on a close ≤ fill × (1 − cut) while `gate` is lit (null = always); once sold it refills only on a close the gate is dark. */
export type Arm = { esc: Partial<Rules>; stop: number; scope: "T1" | "all"; sw: SwitchKey; fillStop?: { cut: number; gate: SwitchKey | null } };

/** Lit = this close is judged on the strict set (`TRANCHE_RULES` + `LEGS`). `s` is cut to `d`; `x` is not. */
export function switchLit(key: SwitchKey, s: SeriesSet, x: Extra, d: string): boolean {
  switch (key) {
    case "none":
      return false;
    case "exsh-ma200":
      return ((c) => c.length < ARM.MA200_CONFIRM_N || c.some((p) => (p.decision ?? -1) < 0))(closes(s.EXSH_GATE).slice(-ARM.MA200_CONFIRM_N));
    case "epath-hicp": {
      const epath = closes(x.EPATH).findLast((p) => p.date <= d);
      const seen = isoDay(new Date(Date.parse(d) - ARM.HICP_LAG_DAYS * DAY));
      const hicp = closes(x.HICP).findLast((p) => p.date <= seen);
      return !!epath?.state && epath.state !== "GREEN" && (hicp?.value ?? 0) > 0;
    }
  }
}

export function armGrid(): Arm[] {
  const stops: [number, Arm["scope"]][] = [[0, "T1"], ...ARM.STOP.flatMap((w): [number, Arm["scope"]][] => [[w, "T1"], [w, "all"]])];
  return stops.flatMap(([stop, scope]) => SWITCHES.map((sw): Arm => ({ esc: {}, stop, scope, sw })));
}

const memo = <T>(m: Map<string, unknown>, key: string, f: () => T): T => {
  if (!m.has(key)) m.set(key, f());
  return m.get(key) as T;
};

type RuleSet = { name: "strict" | "fast"; r: Rules; defs: LegDef[] };
/** `fastAt` overrides the fast set alone (the `--needs` sweep); the strict set never reads it. */
const armSets = (arm: Arm, at: Partial<Rules> = {}, fastAt: Partial<Rules> = {}, fastDefs: LegDef[] = FAST_LEGS): { strict: RuleSet; fast: RuleSet } => ({
  strict: { name: "strict", r: { ...TRANCHE_RULES, ...arm.esc, ...at }, defs: LEGS },
  fast: { name: "fast", r: { ...FAST_RULES, ...arm.esc, ...at, ...fastAt }, defs: fastDefs },
});

/** `replay()` under one arm: the switch picks the rule set per close; a held tranche closing under its stop line is sold and re-arms. `fills` = each tranche's first fill; `drops` trough = the worst over its held stints, each vs its own entry. */
/** `bound`: per episode exit, the closes where `boxHolds` alone keeps an unfilled tranche from firing. */
export function armReplay(s: SeriesSet, x: Extra, arm: Arm, k: ReplayKnobs = REPLAY, cache: Map<string, unknown> = new Map(), fastAt: Partial<Rules> = {}, fastDefs: LegDef[] = FAST_LEGS, bound?: Map<string, string[]>): EpisodeResult[] {
  const px = closes(s.EXSH_GATE);
  return episodes(s.EXSH_GATE, k).map((e) => {
    const sets = armSets(arm, { EXIT_DATE: e.exit }, fastAt, fastDefs);
    const from = cutFrom(e.shockStart, k);
    const cut = Object.fromEntries(SERIES.map((id) => [id, s[id].filter((p) => p.date >= from && p.date <= e.end)])) as SeriesSet;
    const exsh = closes(cut.EXSH_GATE);
    let reached: (string | null)[] = [null, null, null];
    const first: (string | null)[] = [null, null, null];
    const entry = [0, 0, 0];
    const line = [0, 0, 0];
    const since = ["", "", ""];
    const stints: [string, string][][] = [[], [], []];
    const sold = [false, false, false];
    const fs = arm.fillStop;
    const lit = (key: SwitchKey, t: SeriesSet, d: string): boolean => memo(cache, `sw|${key}|${e.exit}|${d}`, () => switchLit(key, t, x, d));
    let ret = 0;
    const binding: string[] = [];
    bound?.set(e.exit, binding);
    for (const d of exsh.filter((p) => p.date > e.exit).map((p) => p.date)) {
      const t = memo(cache, `t|${e.exit}|${d}`, () => truncate(cut, d));
      const which = lit(arm.sw, t, d) ? "strict" : "fast";
      const { r, defs } = sets[which];
      const legs = memo(cache, `legs|${which}|${e.exit}|${d}`, () => legsAt(t, r, defs));
      const esc = memo(cache, `esc|${e.exit}|${d}`, () => escalation(t, r));
      const price = priceAt(px, d);
      const bear = fs !== undefined && (fs.gate === null || lit(fs.gate, t, d));
      const fillHit = reached.map((f, i) => f !== null && bear && price <= entry[i]! * (1 - fs.cut));
      const stopped = reached.map((f, i) => fillHit[i]! || (f !== null && arm.stop > 0 && (arm.scope === "all" || i === 0) && price < line[i]!));
      stopped.forEach((hit, i) => hit && ((ret += (price / entry[i]! - 1) / 3), stints[i]!.push([since[i]!, d]), (reached[i] = null), (sold[i] ||= fillHit[i]! && fs!.gate !== null)));
      const mask = (out: (string | null)[]) => out.map((f, i) => (stopped[i] || (sold[i] && bear && reached[i] === null) ? null : f));
      const next = mask(cascade(tally(legs, r, esc, sessionsSinceExit(t, r)), reached, d, r, exsh));
      const held = (i: number): boolean => reached[i] === null && next[i] === null && boxHolds(TRANCHES[i]!, esc);
      if (bound && [0, 1, 2].some(held)) {
        const freed = mask(cascade(tally(legs.map((l, j) => (isBoxRow(defs[j]!) ? { ...l, verdict: "met" as const } : l)), r, clearBox(esc), sessionsSinceExit(t, r)), reached, d, r, exsh));
        if (freed.some((f, i) => f !== null && held(i))) binding.push(d);
      }
      next.forEach((f, i) => {
        if (f === null || reached[i] !== null) return;
        entry[i] = price;
        since[i] = d;
        line[i] = (1 - arm.stop) * Math.min(...px.filter((p) => p.date >= e.exit && p.date <= d).map((p) => p.value!));
        first[i] ??= d;
      });
      reached = next;
    }
    const last = priceAt(px, e.end);
    reached.forEach((f, i) => f !== null && ((ret += (last / entry[i]! - 1) / 3), stints[i]!.push([since[i]!, e.end])));
    const drops = fillDrops(s.EXSH_GATE, first, e.end).map((dr, i) => dr && { ...dr, trough: Math.min(...stints[i]!.map(([a, b]) => fillDrops(s.EXSH_GATE, [a], b)[0]!.trough)) });
    return { ...e, hold: last / priceAt(px, e.exit) - 1, ret, fills: first, drops };
  });
}

const TRANCHES = ["T1", "T2", "T3"] as const;
const isBoxRow = (d: LegDef): boolean => d.key === tkey(d.tranche, "esc");
/** The same close with the box cleared on every tranche (`boxHolds` false). */
const clearBox = (e: Escalation): Escalation => clearedBox(e);

/** Binding closes of the box over one window, split by `classifyBinding` off the fund's price; THIN only off `holdoutVerdict` (no coverage check here). */
export function bindingRows(s: SeriesSet, k: ReplayKnobs, arm: Arm = SHIPPED_ARM): BindingRow[] {
  const bound = new Map<string, string[]>();
  const rows = armReplay(s, NO_EXTRA, arm, k, new Map(), {}, FAST_LEGS, bound);
  const vd = holdoutVerdict(rows);
  const split = rows.map((e) => classifyBinding(s.EXSH_GATE, e, bound.get(e.exit) ?? []));
  return [{ arm: "ruled", esc: split.reduce((n, c) => n + c.esc, 0), fizzle: split.reduce((n, c) => n + c.fizzle, 0), pass: vd.pass, acceptance: acceptance(vd, []) }];
}

/** `--replay=why:<window>`: each shipped `armReplay` fill's own rows at its fill close (the set its switch picks), routed as `cascade` fired it — `count met/need`, `time stop` or `after T<k>`. */
export function whyFills(s: SeriesSet, k: ReplayKnobs = REPLAY, arm: Arm = SHIPPED_ARM): WhyRow[] {
  // A stop arm re-arms a sold tranche, so `fills` (first fills) would no longer be the `reached` its cascade read.
  if (arm.stop > 0 || arm.fillStop) throw new Error("whyFills: a stop arm's fills are not its cascade state");
  return armReplay(s, NO_EXTRA, arm, k).flatMap((e) => {
    const from = cutFrom(e.shockStart, k);
    const cut = Object.fromEntries(SERIES.map((id) => [id, s[id].filter((p) => p.date >= from && p.date <= e.end)])) as SeriesSet;
    const exsh = closes(cut.EXSH_GATE);
    const sets = armSets(arm, { EXIT_DATE: e.exit });
    return e.fills.flatMap((d, i): WhyRow[] => {
      if (d === null) return [];
      const t = truncate(cut, d);
      const { r, defs } = switchLit(arm.sw, t, NO_EXTRA, d) ? sets.strict : sets.fast;
      const legs = legsAt(t, r, defs);
      const raw = tally(legs, r, escalation(t, r), sessionsSinceExit(t, r))[i]!;
      const via = raw.ready ? (raw.via ?? `count ${raw.metCount}/${raw.need}`) : fires(raw, i, e.fills.map((f) => (f !== null && f <= d ? f : null)), d, r, exsh) ? `after T${i}` : null;
      if (via === null) throw new Error(`whyFills: ${TRANCHES[i]} ${d} filled with neither its count, the time stop nor an after-N`);
      return [{ exit: e.exit, tranche: TRANCHES[i]!, date: d, trough: e.drops[i]?.trough ?? null, rows: legs.flatMap((l, j) => (l.tranche === TRANCHES[i] ? [{ key: defs[j]!.key.replace(/^t\d-/, ""), gate: l.gate, verdict: l.verdict }] : [])), via }];
    });
  });
}

export type ArmRow = { arm: Arm; rows: EpisodeResult[]; worstBear: number; all: number; knobs: number; pass: boolean };

/** The plan's pass rule, best arm first: passing, then the all-episode total, then fewer non-default knobs. */
export function judge(runs: { arm: Arm; rows: EpisodeResult[] }[], currentAll: number): ArmRow[] {
  return runs
    .map(({ arm, rows }): ArmRow => {
      const worstBear = Math.min(0, ...rows.filter((x) => x.shape === "BEAR").map((x) => x.ret));
      const all = replayTotals(rows, "ret").all;
      const knobs = Number(arm.stop > 0) + Number(arm.sw !== "none");
      return { arm, rows, worstBear, all, knobs, pass: worstBear >= ARM.PASS_WORST_BEAR && all > currentAll };
    })
    .sort((a, b) => Number(b.pass) - Number(a.pass) || b.all - a.all || a.knobs - b.knobs);
}

/** The holdout: WINNER between FROM and TO on upstream feeds read from FEED_FROM (the window = the shared `HOLDOUT_WINDOW`, ladder-replay.ts); fewer than THIN_BEARS bear episodes prints THIN; an id with closes in FROM → TO under MIN_COVER × the fund's throws. */
export const HOLDOUT = {
  ...HOLDOUT_WINDOW,
  WINNER: { stop: 0, sw: "exsh-ma200" },
} as const;

/** Euro sovereign-crisis holdout, pre-registered blind (no tuning on it). The fund upstream from FEED_FROM; AT1 (2018+) reads n/a. */
export const HOLDOUT_2011 = {
  FROM: "2010-01-01",
  TO: "2012-12-31",
  FEED_FROM: "2008-01-02",
  THIN_BEARS: HOLDOUT.THIN_BEARS,
} as const;

const NO_EXTRA: Extra = { EPATH: [], HICP: [] };
/** The shipped rule = the holdout's arm. */
export const SHIPPED_ARM: Arm = armGrid().find((a) => a.stop === HOLDOUT.WINNER.stop && a.sw === HOLDOUT.WINNER.sw)!;

/** The stop arms read side by side (`--stop-arms`), each on the shipped arm; the ungated fill row is a control, never a candidate. */
export const STOP_ARMS: { name: string; arm: Arm }[] = [
  { name: "shipped", arm: SHIPPED_ARM },
  ...ARM.STOP.map((w) => ({ name: `stop ${w * 100}% all`, arm: { ...SHIPPED_ARM, stop: w, scope: "all" as const } })),
  { name: `fill −${ARM.BEAR_STOP * 100}% (control)`, arm: { ...SHIPPED_ARM, fillStop: { cut: ARM.BEAR_STOP, gate: null } } },
  { name: `fill −${ARM.BEAR_STOP * 100}% if bear`, arm: { ...SHIPPED_ARM, fillStop: { cut: ARM.BEAR_STOP, gate: "exsh-ma200" } } },
];

/** The shipped verdict: each close judged on the set its switch picks; `inactive` = the other set's own-leg tally at the latest close, never a verdict. */
export function evaluateShipped(s: SeriesSet, signs: readonly SignLite[] = []) {
  const sets = armSets(SHIPPED_ARM);
  const pick = (t: SeriesSet, d: string): RuleSet => (switchLit(SHIPPED_ARM.sw, t, NO_EXTRA, d) ? sets.strict : sets.fast);
  const active = pick(s, closes(s.EXSH_GATE).at(-1)?.date ?? "");
  const other = active === sets.strict ? sets.fast : sets.strict;
  return {
    ...evaluate(s, active.r, active.defs, pick, signs),
    regime: { set: active.name, exshVsMa200: closes(s.EXSH_GATE).at(-1)?.decision ?? null },
    inactive: { set: other.name, tranches: rawAt(s, other.r, other.defs, signs).raw },
  };
}

export function gateSeries(px: { date: string; value: number }[]): Pt[] {
  const c = px.map((p): Pt => ({ date: p.date, value: p.value }));
  return c.map((p, i) => ({ ...p, decision: ((m) => (m === null ? null : p.value! / m - 1))(ma(c, i, 200)) }));
}

const armName = (a: Arm): string => `${(a.stop ? `${a.stop * 100}% ${a.scope}` : "—").padEnd(7)} ${a.sw.padEnd(10)}`;

function armTable(judged: ArmRow[], currentAll: number): string {
  const best = judged[0];
  return [
    `pass = worst bear ≥ ${pct(ARM.PASS_WORST_BEAR)} and all > current ${pct(currentAll)}`,
    "stop    switch      worst bear      all",
    ...judged.map((j) => `${armName(j.arm)}  ${pct(j.worstBear).padStart(10)}  ${pct(j.all).padStart(7)}  ${j.pass ? "PASS" : "FAIL"}`),
    best?.pass ? `\nwinner: ${armName(best.arm).replace(/ +/g, " ")}\n${sweepTable(best.rows)}` : "\nno arm passes",
  ].join("\n");
}

const LIMIT = 400;
const SWEEP_LIMIT = 4000;
/** At SWEEP_LIMIT: EXSH, so `volOf`'s `openShockStart` anchor and its pre-shock base read as replay's stored ones. */
export const liveLimit = (id: Id): number => (id === "EXSH_GATE" ? SWEEP_LIMIT : LIMIT);
const EXSH_SYMBOL = "EXSH.DE";
const MARK: Record<Verdict, string> = { met: "✓", unmet: "✗", na: "–" };
/** A member cell's mark — `CELL_MARK` in public/ladder-views.js. */
const CELL_MARK: Record<string, string> = { hit: "✗ HIT", false: "✓", na: "–", none: "none" };

/** Saturday/Sunday — no session. The ICE BofA OAS series (F1, CCC) store a month-end mark on one, often a spike. */
export const isWeekend = (date: string): boolean => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

/** A roster id comes back `redacted` (values stripped) — never data: read as `na`, a gate series silently
 *  flipped the regime to the strict set and dropped T1's gates (05811472).
 *  A `daily` read drops weekend rows (never counted as a close); a monthly one (HICP, dated the 1st) keeps them. */
export function seriesPoints(url: string, body: { points: Pt[]; redacted?: boolean }, daily = true): Pt[] {
  if (body.redacted) throw new Error(`${url} → redacted (this id's values are not served)`);
  return daily ? body.points.filter((p) => !isWeekend(p.date)) : body.points;
}

/** One `/api/series` read; a non-OK the leg's `unserved` reads as a not-yet-shipped id is empty with a warning, any other throws. */
export async function fetchPoints(base: string, id: string, limit: number, unserved: (status: number, body: string) => boolean = () => false, daily = true): Promise<Pt[]> {
  const url = `${base}/api/series?id=${id}&limit=${limit}`;
  const res = await fetch(url);
  const body = res.ok ? "" : await res.text();
  if (unserved(res.status, body)) {
    console.warn(`not served by ${base} yet: ${id} — reads unread until make ship`);
    return [];
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${body}`);
  return seriesPoints(url, (await res.json()) as { points: Pt[]; redacted?: boolean }, daily);
}
const fetchSeries = (base: string, id: Id | keyof Extra, limit = LIMIT): Promise<Pt[]> => fetchPoints(base, id, limit, undefined, (SERIES as readonly string[]).includes(id));

export type Res = ReturnType<typeof evaluateShipped>;

const WIDTH = 80;

/** One section per tranche, WIDTH columns: each leg a `leg — rule` line over a close row and a live row, the two tranche totals under each. */
function table(res: Res, s: SeriesSet): string {
  const { r, defs } = armSets(SHIPPED_ARM)[res.regime.set];
  const live = liveSet(s);
  const asOf = (set: SeriesSet, key: string): string => {
    const id = defs.find((d) => d.key === key)?.id;
    return id ? (closes(set[id]).at(-1)?.date.slice(5) ?? "") : "";
  };
  const count = (r: Reading): string => (r.count ? `${r.count.got}/${r.count.need}` : "");
  const cells = (l: LegResult): string[][] => [
    ["close", l.value, asOf(s, l.key), count(l), MARK[l.verdict]],
    ["live", l.live.value, asOf(live, l.key), count(l.live), MARK[l.live.verdict]],
  ];
  const all = res.legs.flatMap(cells);
  const w = all[0]!.map((_, c) => Math.max(...all.map((r) => r[c]!.length)));
  const row = (r: string[]): string => `  ${r.map((cell, c) => cell.padEnd(w[c]!)).join("  ")}`.trimEnd();
  const rule = (ch: string, label = ""): string => label + ch.repeat(WIDTH - label.length);
  const gap = res.regime.exshVsMa200;
  const out: string[] = [`regime: EXSH ${gap === null ? "—" : pct(gap)} vs MA200 → ${res.regime.set} set`];
  for (const [i, t] of (["T1", "T2", "T3"] as const).entries()) {
    out.push(rule("─", `── ${t} `));
    for (const l of res.legs.filter((x) => x.tranche === t)) {
      const [close, now] = cells(l);
      out.push(`${l.leg} — ${l.rule}`, row(close!), row(now!));
    }
    out.push(rule("┄"), `${t} total  close  ${probeTrancheCell(res.tranches[i]!)}`, `${"".padEnd(8)}  live   ${probeTrancheCell(res.tranchesLive[i]!)}`, "");
  }
  const esc = res.escalation;
  out.push(
    `escalation box: ${boxStatus(esc)} · ${votesText(esc)}`,
    ...esc.clusters.map((c) => `  ${c.name} (${c.kind}) ${c.hits}/${c.live} live of ${c.n}${c.vote ? " — votes" : ""} · ${c.members.map((m) => `${m.id} ${CELL_MARK[String(m.cell)]}`).join(" ")}`),
    `time stop: ${res.sessionsSinceExit}/${r.TIME_STOP_N} closes since the drawdown opened`,
    `${res.inactive.set} set, not in force: ${res.inactive.tranches.map((t) => `${t.tranche} ${probeTrancheCell({ ...t, met: t.ready, since: null })}`).join(" · ")}`,
    "",
    "– = n/a.",
    "T2 needs T1 met first, T3 needs T2.",
    "live = latest print: estimated closes + the intraday (provisional) head read",
    "as closes.",
  );
  return out.join("\n");
}

const isMain = process.argv[1]?.endsWith("probe-eufin-tranches.ts") ?? false;
if (isMain) {
  const env = readEnv();
  const base = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl();
  const replayArg = process.argv.find((a) => a.startsWith("--replay="))?.slice("--replay=".length);
  const needs = process.argv
    .find((a) => a.startsWith("--needs="))
    ?.slice("--needs=".length)
    .split(",")
    .map((t): Partial<Rules> => {
      const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(t);
      if (!m) throw new Error(`--needs: "${t}" is not a.b.c`);
      return { T1_NEED: Number(m[1]), T2_NEED: Number(m[2]), T3_NEED: Number(m[3]) };
    });
  const needsName = (n: Partial<Rules>): string => `needs ${n.T1_NEED}.${n.T2_NEED}.${n.T3_NEED}`;
  const stopArms = process.argv.includes("--stop-arms");
  // `why:holdout` / `why:holdout2011` / `why:sweep`: the window's shipped scorecard as `whyTable` of `whyFills` — which rows carried each fill.
  // `drift:holdout` / `drift:sweep`: the window's feeds as `holdout` / `sweep` read them, then `fillDrift` of the shipped form against itself — the identity run; a candidate form swaps the second `ReplayRun`.
  if (replayArg === "holdout" || replayArg === "holdout2011" || replayArg === "drift:holdout" || replayArg === "p0:holdout" || replayArg === "why:holdout" || replayArg === "why:holdout2011") {
    const { fetchDailyCloses } = await import("../src/prices.js");
    const H = replayArg.endsWith("holdout2011") ? HOLDOUT_2011 : HOLDOUT;
    const px = await fetchDailyCloses(EXSH_SYMBOL, { deep: true, now: Date.now, env });
    // AT1 scored here from live inputs, not the stored series — the denominator re-base reads before its restate (plan at1-gate-bund-denominator R7).
    const at1Spec = (await import("../src/registry-price.js")).PRICE_SCORERS.find((d) => d.indicator.id === "AT1")!;
    const at1 = async (): Promise<Pt[]> => at1Spec.series(Object.fromEntries(await Promise.all(at1Spec.inputs.map(async (sym) => [sym, await fetchDailyCloses(sym, { deep: true, now: Date.now, env })] as const)))).map((r): Pt => ({ date: r.date, value: r.level, decision: r.decision ?? null }));
    const all: SeriesSet = { AT1: H === HOLDOUT ? await at1() : [], EXSH_GATE: gateSeries(px) };
    const s = Object.fromEntries(SERIES.map((id) => [id, all[id].filter((p) => !isWeekend(p.date) && p.date >= (id === "EXSH_GATE" ? "" : H.FEED_FROM) && p.date <= H.TO)])) as SeriesSet;
    // A fed id with under MIN_COVER of EXSH's closes in FROM → TO has holes the replay would read as sparse closes.
    const inWindow = (id: Id): number => closes(s[id]).filter((p) => p.date >= H.FROM).length;
    console.log(`closes in ${H.FROM} → ${H.TO}: ${SERIES.map((id) => `${id} ${inWindow(id)}`).join(" · ")}`);
    const sparse = SERIES.filter((id) => inWindow(id) > 0 && inWindow(id) < HOLDOUT.MIN_COVER * inWindow("EXSH_GATE"));
    if (sparse.length) throw new Error(`holdout feeds short in the window: ${sparse.join(", ")}`);
    const arm = SHIPPED_ARM;
    const cache = new Map<string, unknown>();
    if (process.argv.includes("--t1-arms")) {
      console.log(`${replayArg} ${H.FROM} → ${H.TO} · pass = worst bear ≥ ${pct(ARM.PASS_WORST_BEAR)} and every fill trough ≥ ${pct(ARM.PASS_WORST_FILL_DROP)}`);
      for (const a of T1_ARMS) {
        const rows = armReplay(s, NO_EXTRA, arm, { ...REPLAY, FROM: H.FROM }, new Map(), a.at, a.defs);
        const vd = holdoutVerdict(rows);
        console.log(`${a.name.padEnd(17)} worst bear ${pct(vd.worstBear).padStart(6)}  worst fill ${pct(vd.worstFill).padStart(6)}  all ${pct(replayTotals(rows, "ret").all).padStart(7)}  ${vd.pass ? "PASS" : "FAIL"}  ${vd.bears} bear / ${vd.realBears} real${vd.thin ? " · THIN" : ""}`);
      }
    }
    if (stopArms) {
      console.log(`${replayArg} ${H.FROM} → ${H.TO} · pass = worst bear ≥ ${pct(ARM.PASS_WORST_BEAR)} and every held fill trough ≥ ${pct(ARM.PASS_WORST_FILL_DROP)}`);
      for (const a of STOP_ARMS) {
        const rows = armReplay(s, NO_EXTRA, a.arm, { ...REPLAY, FROM: H.FROM }, cache);
        const vd = holdoutVerdict(rows);
        console.log(`${stopRow(a.name, rows)}  ${vd.pass ? "PASS" : "FAIL"}  ${vd.bears} bear / ${vd.realBears} real${vd.thin ? " · THIN" : ""}`);
      }
    }
    for (const n of needs ?? []) {
      const rows = armReplay(s, NO_EXTRA, arm, { ...REPLAY, FROM: H.FROM }, cache, n);
      const verdict = holdoutVerdict(rows);
      console.log(`${needsName(n)}  worst bear ${pct(verdict.worstBear)}  worst fill ${pct(verdict.worstFill)}  all ${pct(replayTotals(rows, "ret").all)}  ${verdict.pass ? "PASS" : "FAIL"}`);
    }
    if (replayArg === "drift:holdout") {
      const base = (k: ReplayKnobs): EpisodeResult[] => armReplay(s, NO_EXTRA, SHIPPED_ARM, k);
      const candidate = (k: ReplayKnobs): EpisodeResult[] => armReplay(s, NO_EXTRA, arm, k);
      console.log(`drift:holdout ${H.FROM} → ${H.TO} · ${armName(arm).replace(/ +/g, " ")} vs itself\n${driftTable(fillDrift(s.EXSH_GATE, base, candidate, { ...REPLAY, FROM: H.FROM }))}`);
    } else if (replayArg.startsWith("why:")) {
      console.log(`${replayArg} ${H.FROM} → ${H.TO} · ${armName(arm).replace(/ +/g, " ")} · each fill's own rows at its fill close\n${whyTable(whyFills(s, { ...REPLAY, FROM: H.FROM }, arm))}`);
    } else if (replayArg === "p0:holdout") {
      console.log(`binding days · holdout ${H.FROM} → ${H.TO} · ${armName(SHIPPED_ARM).replace(/ +/g, " ")} · esc = a later close ≤ ${BINDING.ESC_FRAC} × that close by episode end\n${bindingTable(bindingRows(s, { ...REPLAY, FROM: H.FROM }))}`);
    } else if (!needs && !stopArms && !process.argv.includes("--t1-arms")) {
      const rows = armReplay(s, NO_EXTRA, arm, { ...REPLAY, FROM: H.FROM }, cache);
      const verdict = holdoutVerdict(rows);
      console.log(`history starts: ${SERIES.map((id) => `${id} ${s[id][0]?.date ?? "—"}`).join(" · ")}`);
      console.log(`holdout ${H.FROM} → ${H.TO} · ${armName(arm).replace(/ +/g, " ")}\n${sweepTable(rows)}`);
      console.log(`worst bear ${pct(verdict.worstBear)} vs ${pct(ARM.PASS_WORST_BEAR)} · worst fill trough ${pct(verdict.worstFill)} vs ${pct(ARM.PASS_WORST_FILL_DROP)} → ${verdict.pass ? "PASS" : "FAIL"} · ${verdict.realBears} real bear(s)${verdict.thin ? ` · THIN (${verdict.bears} bear episodes)` : ""}`);
    }
  } else if (replayArg === "sweep" || replayArg === "arms" || replayArg === "order" || replayArg === "drift:sweep" || replayArg === "p0:sweep" || replayArg === "why:sweep") {
    const { fetchDailyCloses } = await import("../src/prices.js");
    const ids = SERIES.filter((id) => id !== "EXSH_GATE");
    const s = (await fetchEach(ids, (id) => fetchSeries(base, id, SWEEP_LIMIT))) as SeriesSet;
    s.EXSH_GATE = gateSeries(await fetchDailyCloses(EXSH_SYMBOL, { deep: true, now: Date.now, env }));
    if (replayArg === "order" && needs) {
      for (const n of needs) {
        const rows = orderReplay(s, REPLAY, { ...FAST_RULES, ...SHIPPED_ARM.esc, ...n });
        const early = rows.filter((x) => x.early).length;
        console.log(`${needsName(n)}  early ${early}/${rows.length}`);
      }
    } else if (replayArg === "order") {
      const rows = orderReplay(s);
      for (const x of rows) console.log(`${x.exit} ${x.shape.padEnd(4)}  T1 ${x.t1 ?? "—".padEnd(10)}  (legs ${x.t1Legs ?? "—".padEnd(10)})  T2 own legs ${x.t2 ?? "—".padEnd(10)}  ${x.early ? "✗ before T1" : "✓"}`);
      const early = rows.filter((x) => x.early).length;
      console.log(`${early}/${rows.length} episodes: T2's own legs met before T1 fills`);
    } else if (replayArg === "arms") {
      const x: Extra = { EPATH: await fetchSeries(base, "EPATH", SWEEP_LIMIT), HICP: await fetchSeries(base, "HICP", SWEEP_LIMIT) };
      const cache = new Map<string, unknown>();
      const currentAll = replayTotals(replay(s), "ret").all;
      console.log(armTable(judge(armGrid().map((arm) => ({ arm, rows: armReplay(s, x, arm, REPLAY, cache) })), currentAll), currentAll));
      console.log(`history starts: ${[...ids, "EPATH" as const, "HICP" as const].map((id) => `${id} ${(id === "EPATH" || id === "HICP" ? x[id] : s[id])[0]?.date ?? "—"}`).join(" · ")}`);
    } else if (replayArg === "drift:sweep") {
      const shipped = (k: ReplayKnobs): EpisodeResult[] => armReplay(s, NO_EXTRA, SHIPPED_ARM, k);
      console.log(`drift:sweep ${REPLAY.FROM} → today · ${armName(SHIPPED_ARM).replace(/ +/g, " ")} vs itself\n${driftTable(fillDrift(s.EXSH_GATE, shipped, shipped))}`);
    } else if (replayArg === "why:sweep") {
      console.log(`why:sweep ${REPLAY.FROM} → today · ${armName(SHIPPED_ARM).replace(/ +/g, " ")} · each fill's own rows at its fill close\n${whyTable(whyFills(s))}`);
    } else if (replayArg === "p0:sweep") {
      console.log(`binding days · sweep ${REPLAY.FROM} → today · ${armName(SHIPPED_ARM).replace(/ +/g, " ")} · esc = a later close ≤ ${BINDING.ESC_FRAC} × that close by episode end\n${bindingTable(bindingRows(s, REPLAY))}`);
    } else if (stopArms) {
      const cache = new Map<string, unknown>();
      const shippedAll = replayTotals(armReplay(s, NO_EXTRA, SHIPPED_ARM, REPLAY, cache), "ret").all;
      console.log(`sweep · in = all ≥ shipped ${pct(shippedAll)} − ${pct(ARM.STOP_ALL_SLACK)}`);
      for (const a of STOP_ARMS) {
        const rows = armReplay(s, NO_EXTRA, a.arm, REPLAY, cache);
        console.log(`${stopRow(a.name, rows)}  ${replayTotals(rows, "ret").all >= shippedAll - ARM.STOP_ALL_SLACK ? "IN" : "OUT"}`);
      }
    } else if (needs) {
      const cache = new Map<string, unknown>();
      for (const n of needs) console.log(`${needsName(n)}\n${sweepTable(armReplay(s, NO_EXTRA, SHIPPED_ARM, REPLAY, cache, n))}\n`);
    } else console.log(`strict set alone\n${sweepTable(replay(s))}\n\nshipped\n${sweepTable(armReplay(s, NO_EXTRA, SHIPPED_ARM))}`);
  } else {
    if (replayArg !== undefined) throw new Error(`--replay=${replayArg}: holdout | holdout2011 | sweep | arms | order | drift:holdout | drift:sweep | p0:holdout | p0:sweep | why:holdout | why:holdout2011 | why:sweep`);
    const s = await fetchEach(SERIES, (id) => fetchSeries(base, id, liveLimit(id)));
    const into = process.argv.find((a) => a.startsWith("--into="))?.slice("--into=".length);
    const { existsSync, readFileSync } = await import("node:fs");
    const today = isoDay(new Date());
    const loadLive = (path: string | URL): LadderLive | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LadderLive) : null);
    const live: LadderLive | null = into === undefined ? null : (loadLive(into) ?? { run: today, rules: [], signs: [], events: [], calendar: [], runs: [] });
    // The live `signs[]` rows feed the box (a VETO_ROWS block vetoes) on BOTH paths: a report run reads `public/eufin.json` read-only, so the console box agrees with the md.
    const signs = ((l) => (l ? reviewedSigns(l.signs, allEvents(l), today) : []))(live ?? loadLive(new URL("../public/eufin.json", import.meta.url)));
    const result = evaluateShipped(s, signs);
    if (into !== undefined && live !== null) {
      const [{ toVerdict }, { writeInto }] = await Promise.all([import("../src/ladder-live.js"), import("./ladder-into.js")]);
      const prov = SERIES.some((id) => s[id].at(-1)?.provisional === true);
      live.verdict = toVerdict(result, prov);
      const md = writeInto(into, live, "eufin");
      const tt = live.verdict.tranches.map((t) => `${t.id} ${t.met}/${t.total}${gatesText(t.gates)}`).join(" ");
      console.log(`wrote ${into}${md ? ` + ${md}` : ""} · ${live.verdict.regime.set} set · ${tt}${prov ? " · prov." : ""}`);
    } else if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(table(result, s));
  }
}
