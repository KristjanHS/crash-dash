/**
 * Deep feeds for the ladder replays: stored verdict ids start 2023 on, so each with an upstream route (prices.ts / FRED) is rebuilt from full history
 * (parity vs stored, throws past `PARITY_TOL`). No main: `scripts/ladder-replay-depth.ts --depth` prints each Semis / S&P IT / S&P 500 verdict id's history vs the
 * holdout and sweep windows — it imports the probes, which import this file.
 */
import { readFileSync } from "node:fs";
import { acceptance, bindingTable, classifyBinding, DEEP_LIMIT, driftTable, fillDrift, HOLDOUT_WINDOW, holdoutVerdict, parity, REPLAY, replayMode, replayWindow, sweepTable, verdictLine, whyTable, type EpisodeResult, type ReplayKnobs, type ReplayRun, type WhyRow } from "./ladder-replay.js";
import { closes, isWeekend, seriesPoints, type Pt } from "./probe-eufin-tranches.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

type Obs = { date: string; value: number };
type Feeds = Record<string, Pt[]>;

function memo<T>(f: (k: string) => Promise<T>): (k: string) => Promise<T> {
  const m = new Map<string, Promise<T>>();
  return (k) => m.get(k) ?? (m.set(k, f(k)), m.get(k)!);
}
const dailyCloses = memo(async (sym) => (await import("../src/prices.js")).fetchDailyCloses(sym, { deep: true, now: Date.now, env: readEnv() }));
const fred = memo(async (id) => (await import("../src/feed-ports.js")).realFeeds.fetchSeries(id, { fullHistory: true, now: new Date(), env: readEnv() }));

const obs = (o: readonly Obs[]): Pt[] => o.map((x) => ({ date: x.date, value: x.value }));
const ratioPts = (j: { dates: string[]; a: number[]; b: number[] }): Pt[] => j.dates.map((date, i) => ({ date, value: j.a[i]! / j.b[i]! }));
async function rs(id: "MU_RS" | "RS_SMH" | "RS_XLK", num: string, den: string): Promise<Pt[]> {
  const [{ relStrengthBreakReadingSeries }, reg, a, b] = await Promise.all([import("../src/scorers-price.js"), import("../src/registry-price.js"), dailyCloses(num), dailyCloses(den)]);
  return relStrengthBreakReadingSeries(reg[id], a, b).map((x): Pt => ({ date: x.date, value: x.level, state: x.state, decision: x.decision ?? null }));
}
// HCX as the registry scores it (basket ÷ SPY, HCX_BAND): value = the strict-prior 12-mo-high dist `/api/series` serves (`breadthDistSeries`,
// > 0 on a new-high day — never the reading's inclusive, ≤ 0 `decision`), state = its confirmed state
async function hcx(): Promise<Pt[]> {
  const [{ breadthReadingSeries, hcxBasketSeries, breadthDistSeries, breadthConfig }, { HCX }, { HCX_SYMBOLS }] = await Promise.all([import("../src/scorers-price.js"), import("../src/registry-composite.js"), import("../src/family-descriptor-rows.js")]);
  const [spy, ...legs] = await Promise.all(["SPY", ...HCX_SYMBOLS].map(dailyCloses));
  const basket = hcxBasketSeries(Object.fromEntries(HCX_SYMBOLS.map((sym, i) => [sym, legs[i]!])));
  const sm = new Map(spy!.map((o) => [o.date, o.value]));
  const j = basket.filter((o) => sm.has(o.date));
  const dist = breadthDistSeries(j.map((o) => o.value / sm.get(o.date)!), breadthConfig("HCX").highWindow);
  const dOf = new Map(j.map((o, i) => [o.date, dist[i]!]));
  return breadthReadingSeries(HCX, basket, spy!).map((x): Pt => ({ date: x.date, value: dOf.get(x.date) ?? null, state: x.state }));
}
// GB as the registry scores it (k/7 of GB_SYMBOLS above their own MA200): value = participation, state = its confirmed state
async function gb(): Promise<Pt[]> {
  const [{ globalBreadthReadingSeries }, { GB }, { GB_SYMBOLS }] = await Promise.all([import("../src/scorers-composite.js"), import("../src/registry-composite.js"), import("../src/family-descriptor-rows.js")]);
  const legs = await Promise.all(GB_SYMBOLS.map(dailyCloses));
  return globalBreadthReadingSeries(GB, Object.fromEntries(GB_SYMBOLS.map((sym, i) => [sym, legs[i]!]))).map((x): Pt => ({ date: x.date, value: x.level, state: x.state }));
}
const hyoas = async (): Promise<Pt[]> => readFileSync(new URL("./backtest/data/hyoas.csv", import.meta.url), "utf8").trim().split("\n").slice(1).map((l): Pt => ((f) => ({ date: f[0]!, value: Number(f[1]) }))(l.split(","))).filter((p) => p.date !== "" && Number.isFinite(p.value));

const ROUTES = {
  LEGP_SEMIS: async () => {
    const [{ LEG_TICKER, spliceProxyCloses }, sec0, smh, eurusd] = await Promise.all([import("../src/scoreboard.js"), dailyCloses("SEC0.DE"), dailyCloses("SMH"), dailyCloses("EURUSD=X")]);
    return obs(spliceProxyCloses(sec0, smh, eurusd, LEG_TICKER.Semis));
  },
  LEGP_SPIT: async () => obs(await dailyCloses("QDVE.DE")),
  LEGP_SPX: async () => obs(await dailyCloses("SXR8.DE")),
  F8: async () => obs(await dailyCloses("MU")),
  F17: async () => obs(await dailyCloses("JPY=X")),
  F1: hyoas,
  R2: async () => obs(await fred("DGS10")),
  R4: async () => obs(await fred("DFII10")),
  R5: async () => obs(await fred("VIXCLS")),
  // both legs FRED: the same-vendor pair `src/vix_term.ts` scores (the closes feed's `^VIX3M` froze 2026-07-17)
  VT: async () => {
    const [{ alignByDate }, vix, vxv] = await Promise.all([import("../src/scorers-core.js"), fred("VIXCLS"), fred("VXVCLS")]);
    return ratioPts(alignByDate(vix, vxv));
  },
  MU_RS: () => rs("MU_RS", "MU", "SMH"),
  RS_SMH: () => rs("RS_SMH", "SMH", "SPY"),
  RS_XLK: () => rs("RS_XLK", "XLK", "SPY"),
  HCX: hcx,
  GB: gb,
  R6: async () => obs(await dailyCloses("^MOVE")),
  T10Y3M_RAW: async () => obs(await fred("T10Y3M")),
  CG: async () => {
    const [{ alignByDate }, hg, gc] = await Promise.all([import("../src/scorers-core.js"), dailyCloses("HG=F"), dailyCloses("GC=F")]);
    return ratioPts(alignByDate(hg, gc));
  },
} satisfies Record<string, () => Promise<Pt[]>>;
type RouteId = keyof typeof ROUTES;

/** Per verdict id, its upstream full-history rebuild; an id with none reads stored only (`STORED_ONLY`). */
export const DEEP_ROUTES: Partial<Record<string, () => Promise<Pt[]>>> = ROUTES;
/** Snapshot-fed, no upstream archive: read stored at `DEEP_LIMIT` (a build that does not serve it yet reads empty). */
export const STORED_ONLY: readonly string[] = ["CCC", "BBB", "F2", "F3", "F5", "F10"];
/** Weekly-dated verdict ids: `coverageOf` counts them against the fund's in-window ISO weeks, not its closes. */
export const WEEKLY_IDS: readonly string[] = ["F3"];
/** Routed ids a build may not serve yet (`T10Y3M_RAW` until the next ship + backfill): an unserved 400 reads stored empty, and the route then stands without its parity check. */
export const PENDING_SHIP: readonly string[] = ["T10Y3M_RAW"];
/** Upstream bad prints a replay drops, per id (XDEV 2025-10-24 = the closes feed's 57.41 vs ≈49; the 2014 dates print ≈25 vs the ≈19.5 run). */
export const BAD_PRINTS: Readonly<Record<string, readonly string[]>> = {
  XDEV: ["2014-09-11", "2014-09-12", "2014-09-15", "2014-09-16", "2014-09-17", "2014-09-18", "2014-09-19", "2014-09-30", "2014-10-08", "2014-10-10", "2014-10-21", "2014-10-22", "2014-10-31", "2025-10-24"],
};
export const dropBadPrints = (id: string, pts: Pt[]): Pt[] => pts.filter((p) => !BAD_PRINTS[id]?.includes(p.date));
const ROUTE_SRC: Record<RouteId, string> = {
  LEGP_SEMIS: "daily closes SEC0.DE ← SMH·EURUSD splice",
  LEGP_SPIT: "daily closes QDVE.DE",
  LEGP_SPX: "daily closes SXR8.DE",
  F8: "daily closes MU",
  F17: "daily closes JPY=X",
  F1: "hyoas.csv → stored",
  R2: "FRED DGS10",
  R4: "FRED DFII10",
  R5: "VIXCLS",
  VT: "VIXCLS ÷ VXVCLS",
  MU_RS: "daily closes MU ÷ SMH",
  RS_SMH: "daily closes SMH ÷ SPY",
  RS_XLK: "daily closes XLK ÷ SPY",
  HCX: "daily closes HCX basket ÷ SPY",
  GB: "daily closes GB_SYMBOLS > own MA200",
  R6: "daily closes ^MOVE",
  T10Y3M_RAW: "FRED T10Y3M",
  CG: "daily closes HG=F ÷ GC=F",
};
/** Largest |upstream − stored| on the dates both hold (€ legs, MU $, ¥, HY/DGS10/DFII10 %, VIX, ratios, HCX dist; GB under one symbol's 1/7). */
export const PARITY_TOL: Record<RouteId, number> = { LEGP_SEMIS: 1, F8: 2, F17: 1, F1: 0.05, R2: 0.02, MU_RS: 0.02, RS_SMH: 0.02, R4: 0.02, R5: 0.02, HCX: 0.02, LEGP_SPIT: 0.5, LEGP_SPX: 0.5, GB: 1 / 14, VT: 0.02, RS_XLK: 0.02, R6: 0.5, T10Y3M_RAW: 0.02, CG: 0.00002 };
const routed = (id: string): id is RouteId => id in ROUTES;
/** The route's source as `--depth` names it. */
export const routeSrc = (id: string): string => (routed(id) ? ROUTE_SRC[id] : STORED_ONLY.includes(id) ? "stored only" : "NO ROUTE");

/** The Monday of `date`'s ISO week. */
const isoWeek = (date: string): string => ((d) => isoDay(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000)))(new Date(`${date}T00:00:00Z`));
/** Closes per id in `from` → `to`; `short` = every id under `minCover` × `fund`'s closes (a `weekly` id: × the fund's ISO weeks; a blind id included). */
export function coverageOf(s: Partial<Feeds>, ids: readonly string[], fund: string, from: string, to: string, minCover: number = HOLDOUT_WINDOW.MIN_COVER, weekly: readonly string[] = WEEKLY_IDS): { n: Record<string, number>; short: string[] } {
  const inWindow = (id: string): Pt[] => closes(s[id] ?? []).filter((p) => p.date >= from && p.date <= to);
  const n = Object.fromEntries(ids.map((id) => [id, inWindow(id).length]));
  const fundCloses = inWindow(fund);
  const weeks = new Set(fundCloses.map((p) => isoWeek(p.date))).size;
  return { n, short: ids.filter((id) => n[id]! < minCover * (weekly.includes(id) ? weeks : fundCloses.length)) };
}

async function storedSeries(base: string, id: string): Promise<Pt[]> {
  const url = `${base}/api/series?id=${id}&limit=${DEEP_LIMIT}`;
  const res = await fetch(url);
  const body = res.ok ? "" : await res.text();
  if ((STORED_ONLY.includes(id) || PENDING_SHIP.includes(id)) && res.status === 400 && body.includes("id must be one of")) {
    console.warn(`not served by ${base} yet: ${id} — reads empty`);
    return [];
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${body}`);
  return seriesPoints(url, (await res.json()) as { points: Pt[]; redacted?: boolean });
}

export async function deepParts(base: string, ids: readonly string[]): Promise<{ stored: Feeds; up: Partial<Feeds> }> {
  const [stored, up] = await Promise.all([
    Promise.all(ids.map(async (id) => [id, await storedSeries(base, id)] as const)),
    Promise.all(ids.filter(routed).map(async (id) => [id, await ROUTES[id]()] as const)),
  ]);
  return { stored: Object.fromEntries(stored), up: Object.fromEntries(up) };
}

/** Upstream over stored per routed id (F1: upstream before stored's first close, stored on); throws past `PARITY_TOL`; weekends dropped. */
export function mergeDeep(stored: Feeds, up: Partial<Feeds>, ids: readonly string[]): Feeds {
  const checks = ids.filter(routed).filter((id) => !(PENDING_SHIP.includes(id) && !stored[id]?.length)).map((id) => ({ id, ...parity(up[id]!, stored[id]!) }));
  console.log(`parity vs stored (max |Δ| over n shared dates): ${checks.map((x) => `${x.id} ${x.max.toFixed(3)}/${x.n}`).join(" · ")}`);
  const off = checks.filter((x) => x.n === 0 || x.max > PARITY_TOL[x.id]);
  if (off.length) throw new Error(`replay feeds disagree with the stored series: ${off.map((x) => x.id).join(", ")}`);
  const merged: Partial<Feeds> = { ...stored, ...up };
  if (up.F1) merged.F1 = [...up.F1.filter((p) => p.date < (stored.F1![0]?.date ?? "9999")), ...stored.F1!];
  return Object.fromEntries(ids.map((id) => [id, (merged[id] ?? []).filter((p) => !isWeekend(p.date))]));
}

/** Every id in `ids` plus `fund`: stored at `DEEP_LIMIT`, routed ids rebuilt upstream (parity-checked), weekends dropped. */
export async function deepSet(base: string, ids: readonly string[], fund: string): Promise<Feeds> {
  const all = [...new Set([fund, ...ids])];
  const { stored, up } = await deepParts(base, all);
  return mergeDeep(stored, up, all);
}

/** A leg's replay: its fund (`px` = the name prints use), verdict ids, series trim, run, `whyFills`, and the head printed after `<arg> <from> → <to> · ` per mode.
 *  A mode with no head is deferred: `replayScorecard` throws before any fetch, naming `deferred`. */
export type ReplaySpec<S extends Partial<Feeds>> = {
  fund: string;
  px: string;
  ids: readonly string[];
  trim: (all: Feeds, f: (c: Pt[]) => Pt[]) => S;
  run: (s: S, k: ReplayKnobs, bind: boolean) => (EpisodeResult & { binding?: string[] })[];
  why: (s: S, k: ReplayKnobs) => WhyRow[];
  head: Record<"verdict" | "drift" | "why", string> & { p0?: string };
  deferred?: string;
};

/** `--replay=<arg>` (`replayMode`) over `feeds` (`deepSet`: parity breach throws), cut to `replayWindow`: coverage + history lines, then the mode's table via `log` — verdict = `sweepTable` + `verdictLine` (a short verdict id prints THIN, never a shortened window). */
export async function replayScorecard<S extends Partial<Feeds>>(base: string, arg: string, spec: ReplaySpec<S>, today: string = isoDay(new Date()), feeds: typeof deepSet = deepSet, log: (line: string) => void = (line) => console.log(line)): Promise<void> {
  const { mode, window } = replayMode(arg);
  const modeHead = spec.head[mode];
  if (modeHead === undefined) throw new Error(`--replay=${arg}: ${mode} is deferred for the ${spec.px} replay${spec.deferred ? ` (${spec.deferred})` : ""}`);
  const { from, to, feedFrom } = replayWindow(window, today);
  const all = await feeds(base, spec.ids, spec.fund);
  const s = spec.trim(all, (c) => c.filter((p) => p.date >= feedFrom && p.date <= to));
  const cov = coverageOf(s, spec.ids, spec.fund, from, to);
  const k = { ...REPLAY, FROM: from };
  const head = `${arg} ${from} → ${to} · ${modeHead}`;
  const weekly = spec.ids.filter((id) => WEEKLY_IDS.includes(id));
  log(`closes in ${from} → ${to}: ${Object.entries(cov.n).map(([id, n]) => `${id} ${n}`).join(" · ")}`);
  log(`history starts: ${spec.ids.map((id) => `${id} ${closes(s[id] ?? [])[0]?.date ?? "—"}`).join(" · ")} · short (under ${HOLDOUT_WINDOW.MIN_COVER} × ${spec.px}'s in-window closes${weekly.length ? `; weekly ${weekly.join(", ")}: × its ISO weeks` : ""}): ${cov.short.join(", ") || "—"}`);
  if (mode === "drift") {
    const shipped: ReplayRun = (kk) => spec.run(s, kk, false);
    log(`${head}\n${driftTable(fillDrift(s[spec.fund]!, shipped, shipped, k))}`);
  } else if (mode === "why") log(`${head}\n${whyTable(spec.why(s, k))}`);
  else if (mode === "p0") {
    const px = closes(s[spec.fund]!);
    const rows = spec.run(s, k, true);
    const n = rows.map((e) => {
      if (e.binding === undefined) throw new Error(`--replay=${arg}: ${spec.px} episode ${e.exit} returned no binding days with bind on`);
      return classifyBinding(px, e, e.binding);
    }).reduce((a, y) => ({ esc: a.esc + y.esc, fizzle: a.fizzle + y.fizzle }), { esc: 0, fizzle: 0 });
    const vd = holdoutVerdict(rows);
    log(`${head}\n${bindingTable([{ arm: "ruled", ...n, pass: vd.pass, acceptance: acceptance(vd, cov.short) }])}`);
  } else {
    const rows = spec.run(s, k, false);
    log(`${head}\n${sweepTable(rows)}`);
    log(verdictLine(rows, cov.short));
  }
}
