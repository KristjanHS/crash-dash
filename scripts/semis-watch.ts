/** Semis drawdown watch: `SEMIS_WATCH` rows, `WATCH_CLUSTERS` roster, `watchAt`/`watchLatched` grade + latch, `openEpisode`. */
import { kleeneOr, watchOf, type Roster } from "../src/ladder-box.js";
import { fixNum, type LadderEventDone, type LadderSign, type ReadTag, type WatchRole, type WatchRow } from "../src/ladder-live.js";
import { delta, extremeOf, ma, offHigh, quietRun } from "../src/ladder-jobs.js";
import { addDays } from "../src/ladder-run.js";
import { episodes, knob, last, pct, upTo } from "./ladder-replay.js";
import type { Pt } from "./probe-eufin-tranches.js";
import { NO_LINE, sideCell } from "./ladder-tranche.js";
import type { Rules, SignId } from "./probe-semis-tranches.js";
import { EPS, eachId, kMa, tagOf, type SeriesSet } from "./semis-series.js";

const fix = fixNum;

export type WatchKey = "sec0" | "stretch" | "epdd" | "r10" | "hy" | "bbb" | "hcx" | "mu" | "vxsmh" | "ry" | "rs" | "events" | "carriers";
type ManualKey = "capex_guides" | "dram_contract" | "hbm" | "ai_funding" | "sox_breadth" | "taiwan_export" | "pc_demand";
type WatchSide = WatchRow["correction"];
type WatchRead = { now: string; correction: WatchSide; bear: WatchSide; carries?: readonly string[] };
type WatchDef = { key: WatchKey; label: string; cluster: string; role?: WatchRole; sign?: SignId; tag: ReadTag; read: (r: Rules, s: SeriesSet, events: readonly LadderEventDone[], signs: readonly LadderSign[]) => WatchRead };
type ManualDef = { key: ManualKey; label: string; cluster: string; sign: SignId; manual: true };
/** `ok(i)` on each of the last `n` closes. */
const runOf = (c: Pt[], n: number, ok: (i: number) => boolean): boolean => quietRun(c, n, ok) >= n;
const landed = (e: LadderEventDone, k: "escalation" | "mixed" | "fizzle"): boolean => e.status.startsWith(`${k}:`);
/** Drawdown watch rows; a `manual` row shows its sign's lean and never grades. */
export const SEMIS_WATCH: readonly (WatchDef | ManualDef)[] = [
  {
    key: "sec0", label: "SEC0 trend", cluster: "trend", role: "context", tag: tagOf({ series: ["LEGP_SEMIS"], job: "regime", agg: "box" }),
    read: (r, { LEGP_SEMIS: c }) => {
      const [m50, m200, back] = [ma(c, r.MA_FAST_N), ma(c, r.MA_SLOW_N), ma(c.slice(0, Math.max(0, c.length - r.W_MA200_LAG_N)), r.MA_SLOW_N)];
      const px = last(c)?.value ?? 0;
      const under = (i: number): boolean => ((m) => m !== null && c[i]!.value! < r.MA_FAST_K * m)(ma(c.slice(0, i + 1), r.MA_FAST_N));
      return {
        now: c.length ? `SEC0 ${fix(px)} · MA${r.MA_FAST_N} ${fix(m50)} · MA${r.MA_SLOW_N} ${fix(m200)}` : "no history",
        correction: { rule: `< ${kMa(r.MA_FAST_K, r.MA_FAST_N)} ×${r.W_TREND_N}`, cell: sideCell(c, c.length >= r.MA_FAST_N + r.W_TREND_N - 1, () => runOf(c, r.W_TREND_N, under)) },
        bear: { rule: `MA${r.MA_FAST_N} < MA${r.MA_SLOW_N} · MA${r.MA_SLOW_N} < its level ${r.W_MA200_LAG_N} back · < both`, cell: sideCell(c, m50 !== null && m200 !== null && back !== null, () => m50! < m200! && m200! < back! && px < m50! && px < m200!) },
      };
    },
  },
  {
    key: "stretch", label: "SEC0 stretch", cluster: "trend", role: "step", tag: tagOf({ series: ["LEGP_SEMIS"], job: "regime", agg: "box", variant: "k×MA200" }),
    read: (r, s) => {
      const c = s.LEGP_SEMIS;
      const hi = episodeHigh(s, r);
      const m = hi ? ma(c.slice(0, c.indexOf(hi) + 1), r.MA_SLOW_N) : null;
      return {
        now: !hi ? "no history" : m === null ? `${hi.date} high · short of ${r.MA_SLOW_N} closes` : `SEC0 ${hi.date} high ${fix(hi.value! / m)}× its MA${r.MA_SLOW_N}`,
        correction: { rule: `the high since the last episode ended ≥ ${kMa(r.W_STRETCH_K, r.MA_SLOW_N)} at that close`, cell: sideCell(c, m !== null, () => hi!.value! >= r.W_STRETCH_K * m! - EPS) },
        bear: NO_LINE,
      };
    },
  },
  {
    key: "epdd", label: "SEC0 off high", cluster: "depth", tag: tagOf({ series: ["LEGP_SEMIS"], job: "level", agg: "box" }),
    read: (r, s) => {
      const c = s.LEGP_SEMIS;
      const hi = episodeHigh(s, r);
      const dd = hi && last(c)!.value! / hi.value! - 1;
      const off = (k: number) => sideCell(c, true, () => dd! <= k + EPS);
      return {
        now: dd === undefined ? "no history" : `SEC0 ${pct(dd)} off its ${hi!.date} high`,
        correction: { rule: `≤ ${pct(r.W_EPDD_CORR)} off the high since the last episode ended`, cell: off(r.W_EPDD_CORR) },
        bear: { rule: `≤ ${pct(r.W_EPDD_BEAR)}`, cell: off(r.W_EPDD_BEAR) },
      };
    },
  },
  {
    key: "r10", label: "SEC0 speed", cluster: "speed", tag: tagOf({ series: ["LEGP_SEMIS"], job: "speed", agg: "box" }),
    read: (r, { LEGP_SEMIS: c }) => {
      const d = delta(c, r.W_R10_N);
      const ret = d === null ? null : d / c.at(-1 - r.W_R10_N)!.value!;
      const at = (k: number) => sideCell(c, ret !== null, () => ret! <= k + EPS);
      return {
        now: ret === null ? (c.length ? "short history" : "no history") : `SEC0 ${pct(ret)} over ${r.W_R10_N} closes`,
        correction: { rule: `${r.W_R10_N}-close return ≤ ${pct(r.W_R10_CORR)}`, cell: at(r.W_R10_CORR) },
        bear: { rule: `≤ ${pct(r.W_R10_BEAR)}`, cell: at(r.W_R10_BEAR) },
      };
    },
  },
  {
    key: "hy", label: "HY OAS", cluster: "credit", role: "confirmer", tag: tagOf({ series: ["F1"], job: "speed", agg: "box", variant: "absΔ10" }),
    read: (r, { F1 }) => {
      const d = delta(F1, r.W_HY_N);
      return {
        now: F1.length ? `HY ${fix(last(F1)!.value)}${d === null ? "" : ` · Δ${r.W_HY_N} ${d >= 0 ? "+" : ""}${fix(d)}`}` : "no history",
        correction: { rule: `Δ${r.W_HY_N} ≥ +${knob(r.W_HY_D10)}`, cell: sideCell(F1, d !== null, () => d! >= r.W_HY_D10 - EPS) },
        bear: NO_LINE,
      };
    },
  },
  {
    key: "bbb", label: "BBB OAS", cluster: "credit", role: "confirmer", tag: tagOf({ series: ["BBB"], job: "speed", agg: "box", variant: "absΔ10∨lowRise" }),
    read: (r, { BBB: c }) => {
      const d = delta(c, r.W_BBB_N);
      const low = c.length >= r.W_BBB_LOW_N ? extremeOf(c.slice(-r.W_BBB_LOW_N), "low")!.value : null;
      const v = last(c)?.value ?? 0;
      return {
        now: c.length ? `BBB ${fix(v)}${d === null ? "" : ` · Δ${r.W_BBB_N} ${d >= 0 ? "+" : ""}${fix(d)}`}${low === null ? "" : ` · low ${fix(low)}`}` : "no history",
        correction: {
          rule: `Δ${r.W_BBB_N} ≥ +${knob(r.W_BBB_D10)} ∨ ≥ ${r.W_BBB_LOW_N}-close low + ${knob(r.W_BBB_RISE)}`,
          cell: kleeneOr(sideCell(c, d !== null, () => d! >= r.W_BBB_D10 - EPS), sideCell(c, low !== null, () => v >= low! + r.W_BBB_RISE - EPS)),
        },
        bear: NO_LINE,
      };
    },
  },
  {
    key: "hcx", label: "HCX capex basket", cluster: "capex", role: "context", tag: tagOf({ series: ["HCX"], job: "speed", agg: "box", variant: "absΔ20" }),
    read: (r, { HCX }) => {
      const [d, db] = [delta(HCX, r.W_HCX_N), delta(HCX, r.W_HCX_BEAR_N)];
      const at = (x: number | null, k: number) => sideCell(HCX, x !== null, () => x! <= k + EPS);
      return {
        now: HCX.length ? `HCX ${pct(last(HCX)!.value!)} off 12-mo high${d === null ? "" : ` · Δ${r.W_HCX_N} ${pct(d)}`}${db === null ? "" : ` · Δ${r.W_HCX_BEAR_N} ${pct(db)}`}` : "no history",
        correction: { rule: `Δ${r.W_HCX_N} ≤ ${pct(r.W_HCX_D20)}`, cell: at(d, r.W_HCX_D20) },
        bear: { rule: `Δ${r.W_HCX_BEAR_N} ≤ ${pct(r.W_HCX_D63)}`, cell: at(db, r.W_HCX_D63) },
      };
    },
  },
  {
    key: "mu", label: "MU off high", cluster: "memory", role: "context", tag: tagOf({ series: ["F8"], job: "relative", agg: "box" }),
    read: (r, { F8 }) => {
      const dd = F8.length >= r.MU_HIGH_N ? offHigh(F8, r.MU_HIGH_N)!.dd : null;
      return {
        now: F8.length ? `MU ${fix(last(F8)!.value)}${dd === null ? "" : ` · ${pct(dd)} off ${r.MU_HIGH_N}-close high`}` : "no history",
        correction: { rule: `≤ ${pct(r.W_MU_CORR)} off ${r.MU_HIGH_N}-close high`, cell: sideCell(F8, dd !== null, () => dd! <= r.W_MU_CORR + EPS) },
        bear: { rule: `≤ ${pct(r.W_MU_BEAR)}`, cell: sideCell(F8, dd !== null, () => dd! <= r.W_MU_BEAR + EPS) },
      };
    },
  },
  {
    key: "vxsmh", label: "VXSMH", cluster: "vol", role: "confirmer", sign: "vxsmh", tag: tagOf({ series: ["VXSMH"], job: "speed", agg: "box", variant: "pctΔ10" }),
    read: (r, { VXSMH: c }) => {
      const d = delta(c, r.W_VXSMH_N);
      const ret = d === null ? null : d / c.at(-1 - r.W_VXSMH_N)!.value!;
      return {
        now: c.length ? `VXSMH ${fix(last(c)!.value)}${ret === null ? "" : ` · Δ${r.W_VXSMH_N} ${pct(ret)}`}` : "no history",
        correction: { rule: `Δ${r.W_VXSMH_N} ≥ ${pct(r.W_VXSMH_D10)}`, cell: sideCell(c, ret !== null, () => ret! >= r.W_VXSMH_D10 - EPS) },
        bear: NO_LINE,
      };
    },
  },
  {
    key: "ry", label: "10y real yield", cluster: "rates", role: "context", tag: tagOf({ series: ["R4"], job: "speed", agg: "box", variant: "absΔ20" }),
    read: (r, { R4 }) => {
      const d = delta(R4, r.W_RY_N);
      const at = (k: number) => sideCell(R4, d !== null, () => d! >= k - EPS);
      return {
        now: R4.length ? `RY ${fix(last(R4)!.value)}${d === null ? "" : ` · Δ${r.W_RY_N} ${d >= 0 ? "+" : ""}${fix(d)}`}` : "no history",
        correction: { rule: `Δ${r.W_RY_N} ≥ +${knob(r.W_RY_D20)}`, cell: at(r.W_RY_D20) },
        bear: { rule: `Δ${r.W_RY_N} ≥ +${knob(r.W_RY_BEAR)}`, cell: at(r.W_RY_BEAR) },
      };
    },
  },
  {
    key: "rs", label: "SMH vs SPY", cluster: "leadership", role: "context", tag: tagOf({ series: ["RS_SMH"], job: "speed", agg: "box", variant: "pctΔ20" }),
    read: (r, { RS_SMH: c }) => {
      const d = delta(c, r.W_RS_N);
      const ret = d === null ? null : d / c.at(-1 - r.W_RS_N)!.value!;
      const at = (k: number) => sideCell(c, ret !== null, () => ret! <= k + EPS);
      return {
        now: c.length ? `RS ${fix(last(c)!.value)}${ret === null ? "" : ` · Δ${r.W_RS_N} ${pct(ret)}`}` : "no history",
        correction: { rule: `Δ${r.W_RS_N} ≤ ${pct(r.W_RS_D20)}`, cell: at(r.W_RS_D20) },
        bear: { rule: `≤ ${pct(r.W_RS_BEAR)}`, cell: at(r.W_RS_BEAR) },
      };
    },
  },
  {
    key: "events", label: "landed events", cluster: "events", tag: tagOf({ series: [], indicator: "landed events", job: "manual", agg: "box" }),
    read: (r, { LEGP_SEMIS }, events) => {
      const d = last(LEGP_SEMIS)?.date;
      const within = (n: number): LadderEventDone[] => (d === undefined ? [] : events.filter((e) => e.date <= d && e.date >= addDays(d, -n)));
      const [w, wb] = [within(r.W_EVENT_DAYS), within(r.W_EVENT_BEAR_DAYS)];
      const corr = w.filter((e) => landed(e, "escalation"));
      const esc = wb.filter((e) => landed(e, "escalation"));
      const bear = esc.length >= r.W_EVENT_BEAR_N || esc.some((e) => e.holds.length > 0);
      const n = (k: "escalation" | "mixed" | "fizzle"): number => w.filter((e) => landed(e, k)).length;
      return {
        now: d === undefined ? "no history" : `esc ${n("escalation")} · mixed ${n("mixed")} · fizzle ${n("fizzle")} (${r.W_EVENT_DAYS}d)`,
        correction: { rule: `≥ 1 escalation ≤ ${r.W_EVENT_DAYS}d`, cell: sideCell(LEGP_SEMIS, true, () => corr.length > 0) },
        bear: { rule: `≥ ${r.W_EVENT_BEAR_N} escalations, or a holding event's, ≤ ${r.W_EVENT_BEAR_DAYS}d`, cell: sideCell(LEGP_SEMIS, true, () => bear) },
        carries: [...new Set([...corr, ...(bear ? esc : [])].flatMap((e) => e.signs))],
      };
    },
  },
  {
    // [USER] R4 carrier breadth: shown, never votes.
    key: "carriers", label: "carrier breadth", cluster: "events", role: "context", tag: tagOf({ series: [], indicator: "carrier breadth", job: "manual", agg: "box" }),
    read: (r, { LEGP_SEMIS }, events) => {
      const d = last(LEGP_SEMIS)?.date;
      const esc = d === undefined ? [] : events.filter((e) => e.date <= d && e.date >= addDays(d, -r.W_EVENT_DAYS) && landed(e, "escalation"));
      return {
        now: d === undefined ? "no history" : `esc ${esc.length} (${r.W_EVENT_DAYS}d)`,
        correction: { rule: `≥ ${r.W_CARRIER_N} escalations ≤ ${r.W_EVENT_DAYS}d`, cell: sideCell(LEGP_SEMIS, true, () => esc.length >= r.W_CARRIER_N) },
        bear: NO_LINE,
      };
    },
  },
  { key: "capex_guides", label: "capex guides", cluster: "capex", sign: "capex_guides", manual: true },
  { key: "dram_contract", label: "DRAM contract", cluster: "memory", sign: "dram_contract", manual: true },
  { key: "hbm", label: "HBM", cluster: "memory", sign: "hbm", manual: true },
  { key: "ai_funding", label: "AI funding", cluster: "capex", sign: "ai_funding", manual: true },
  { key: "sox_breadth", label: "SOX breadth", cluster: "trend", sign: "sox_breadth", manual: true },
  { key: "taiwan_export", label: "Taiwan export", cluster: "export", sign: "taiwan_export", manual: true },
  { key: "pc_demand", label: "PC demand", cluster: "memory", sign: "pc_demand", manual: true },
];
/** The watch roster (`watchOf`); manual and `role` rows (context, confirmer, step) never sit in it. */
export const WATCH_CLUSTERS = [
  { name: "depth", kind: "coincident", members: ["epdd"] },
  { name: "speed", kind: "coincident", members: ["r10"] },
  { name: "events", kind: "lead", members: ["events"] },
] as const satisfies Roster<WatchKey>;
/** Each `SEMIS_WATCH` row read over `s`, carrying the sign rows its `sign` (the events row: its counted events' signs) names. */
export const watchAt = (s: SeriesSet, signs: readonly LadderSign[], events: readonly LadderEventDone[], r: Rules): WatchRow[] =>
  SEMIS_WATCH.map((d): WatchRow => {
    const carry = (ids: readonly string[]) => ((g) => (g.length ? { signs: g } : {}))(signs.filter((x) => ids.includes(x.sign)).map(({ sign, lean, block }) => ({ sign, lean, block })));
    if ("manual" in d) return { key: d.key, label: d.label, cluster: d.cluster, now: "—", correction: { rule: "manual", cell: "na" }, bear: { rule: "manual", cell: "na" }, manual: true, ...carry([d.sign]), tag: { indicator: d.label, series: [], job: "manual", agg: "box" } };
    const { carries, ...read } = d.read(r, s, events, signs);
    return { key: d.key, label: d.label, cluster: d.cluster, ...(d.role ? { role: d.role } : {}), ...read, ...carry(carries ?? (d.sign ? [d.sign] : [])), tag: d.tag };
  });
/** `watchOf` over `watchAt(s)`; a non-thin ELEVATED → HIGH by the confirmer lift (a lead cluster votes ∧ a `confirmer` row's correction hit: `lifted` = those keys) and, in an open
 *  episode, by the latch (epdd ≤ W_LATCH_DD ∧ a raw HIGH/SEVERE since the epdd anchor high: `latched`) and/or the stretch step (`stretch` hit ∧ some session since the anchor reached epdd ≤ W_STRETCH_DD — any, thin or raw-HIGH included — with every
 *  session from it to now at epdd ≤ W_STRETCH_HOLD: `stretched`). */
export function watchLatched(s: SeriesSet, signs: readonly LadderSign[], events: readonly LadderEventDone[], r: Rules): { rows: WatchRow[]; latched?: string; stretched?: string; lifted?: string[] } & ReturnType<typeof watchOf> {
  const rows = watchAt(s, signs, events, r);
  const now = { rows, ...watchOf(WATCH_CLUSTERS, rows) };
  if (now.grade !== "ELEVATED") return now;
  const lead = now.correction.clusters.some((x) => x.kind === "lead" && x.vote);
  const hits = rows.filter((x) => x.role === "confirmer" && x.correction.cell === "hit").map((x) => x.key);
  const lifted = lead && hits.length ? hits : undefined;
  const c = s.LEGP_SEMIS;
  const hi = episodeHigh(s, r);
  let latched: string | undefined;
  let stretched: string | undefined;
  if (hi && openEpisode(s)) {
    const ddAt = (i: number) => c[i]!.value! / hi.value! - 1;
    const dd = ddAt(c.length - 1);
    let entered = false;
    for (let i = c.length - 1; !entered && i >= 0 && c[i]!.date >= hi.date && ddAt(i) <= r.W_STRETCH_HOLD + EPS; i--) entered = ddAt(i) <= r.W_STRETCH_DD + EPS;
    stretched = rows.find((x) => x.key === "stretch")!.correction.cell === "hit" && entered ? hi.date : undefined;
    const deep = dd <= r.W_LATCH_DD + EPS;
    for (let i = c.length - 2; deep && !latched && i >= 0 && c[i]!.date >= hi.date; i--) {
      const g = watchOf(WATCH_CLUSTERS, watchAt(eachId(s, upTo(c[i]!.date)), signs, events, r)).grade;
      if (g === "HIGH" || g === "SEVERE") latched = c[i]!.date;
    }
  }
  return latched || stretched || lifted ? { ...now, grade: "HIGH", ...(latched && { latched }), ...(stretched && { stretched }), ...(lifted && { lifted }) } : now;
}

export type WatchSession = { date: string; grade: ReturnType<typeof watchOf>["grade"]; latched?: string; stretched?: string; lifted?: string[]; cells: Record<string, readonly [WatchSide["cell"], WatchSide["cell"]]> };
/** Per SEC0 session: the latched grade (`watchLatched`) and each graded row's [correction, bear] cell, read over the closes up to that
 *  session — the drawdown-watch harness table (Stage 2.2). */
export const watchTimeline = (s: SeriesSet, signs: readonly LadderSign[], events: readonly LadderEventDone[], r: Rules): WatchSession[] =>
  s.LEGP_SEMIS.map(({ date }) => {
    const w = watchLatched(eachId(s, upTo(date)), signs, events, r);
    return { date, grade: w.grade, ...(w.latched ? { latched: w.latched } : {}), ...(w.stretched ? { stretched: w.stretched } : {}), ...(w.lifted ? { lifted: w.lifted } : {}), cells: Object.fromEntries(w.rows.filter((x) => !x.manual).map((x) => [x.key, [x.correction.cell, x.bear.cell] as const])) };
  });

/** The open `episodes` exit + shock start over SEC0 closes, open until the shared episode end (`episodes`); undefined = none open.
 * [default] exit = the shared `REPLAY` (ladder-replay.ts): a close ≤ (1 − DROP) × its running high. */
export function openEpisode(c: SeriesSet): { exit: string; start: string } | undefined {
  const e = episodes(c.LEGP_SEMIS).at(-1);
  return e?.open ? { exit: e.exit, start: e.shockStart } : undefined;
}
/** The `epdd` anchor: the max SEC0 close since the last closed episode's `end` (the `W_EPDD_HIGH_N`-close high when none closed); undefined = no closes. */
function episodeHigh(s: SeriesSet, r: Rules): Pt | undefined {
  const c = s.LEGP_SEMIS;
  const end = episodes(c).filter((e) => !e.open).at(-1)?.end;
  const w = end === undefined ? c.slice(-r.W_EPDD_HIGH_N) : c.filter((p) => p.date >= end);
  return w.length ? w.reduce((a, b) => (b.value! > a.value! ? b : a)) : undefined;
}
