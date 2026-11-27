import { isoDay } from "../src/dates.js";
/** Shared replay core for the ladder probes — a leaf: no imports, so every leg's probe can import it. */

export type Pt = {
  date: string;
  value: number | null;
  decision?: number | null;
  provisional?: boolean | null;
  estimated?: boolean | null;
  state?: string | null;
};

export const isFinal = (p: Pt): boolean => !p.provisional && !p.estimated && p.value !== null;
const dateCmp = (a: Pt, b: Pt): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
/** A fresh ascending copy; ISO dates order by `<`, and an already-sorted input skips the sort. */
export function byDate(pts: Pt[]): Pt[] {
  for (let i = 1; i < pts.length; i++) if (pts[i - 1]!.date > pts[i]!.date) return [...pts].sort(dateCmp);
  return pts.slice();
}

/** Final prints only — the population every peak, run and single-value verdict reads. */
export function closes(pts: Pt[]): Pt[] {
  return byDate(pts).filter(isFinal);
}

export const v = (c: Pt[], i: number): number => c[i]!.value!;

/** Replay knobs: `episodes()` peak-and-trough ([USER] 2026-10-18) — `TIE` start band, `DROP_K` × one-month σ exit, `RISE_K` × annual σ end; σ over `VOL_N` log returns. */
export const REPLAY = { FROM: "2021-11-01", TIE: 0.001, DROP_K: 0.7, RISE_K: 0.455, VOL_N: 250, SHAPE_N: 8, PRE_DAYS: 600 } as const;
export type ReplayKnobs = { [K in keyof typeof REPLAY]: (typeof REPLAY)[K] extends string ? string : number };
export type Shape = "BEAR" | "V";
/** `open` = no end close yet (`end` is then the last close); `drop`/`rise` = this episode's exit and end fractions. */
export type Episode = { shockStart: string; exit: string; end: string; open: boolean; drop: number; rise: number; shape: Shape; troughLag: number };

/** Annualised sample sd of the `n` daily log returns ending at close `i`; null short of `n` returns. */
export function sigmaAt(c: Pt[], i: number, n: number): number | null {
  if (i < n) return null;
  const r = Array.from({ length: n }, (_, j) => Math.log(v(c, i - j) / v(c, i - j - 1)));
  const m = r.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) * Math.sqrt(252);
}

/** Running high (from close `VOL_N`, restarted at each end close) → exit on the first close ≤ (1 − drop) × it; end on the first close ≥ it or
 *  ≥ (1 + rise) × the lowest close since the exit. drop = DROP_K × σ × √(21/252), rise = RISE_K × σ, σ = `sigmaAt` the high's close.
 *  `shockStart` = the latest close within `TIE` of the high; only exits on/after `FROM` are returned. BEAR = the low prints more than SHAPE_N closes after the exit. */
export function episodes(px: Pt[], k: ReplayKnobs = REPLAY): Episode[] {
  const c = closes(px);
  const out: Episode[] = [];
  let h = k.VOL_N;
  /** σ at the high, recomputed only when the high moves — the per-close O(VOL_N) recompute made every walk O(n·VOL_N). */
  let [sigH, sigma] = [-1, 0];
  for (let i = h + 1; i < c.length; i++) {
    if (v(c, i) > v(c, h)) h = i;
    if (h !== sigH) [sigH, sigma] = [h, sigmaAt(c, h, k.VOL_N)!];
    const drop = k.DROP_K * sigma * Math.sqrt(21 / 252);
    if (!(drop > 0) || v(c, i) > (1 - drop) * v(c, h)) continue;
    const rise = k.RISE_K * sigma;
    let start = i - 1;
    while (v(c, start) < (1 - k.TIE) * v(c, h)) start--;
    let low = i;
    let end = -1;
    for (let j = i + 1; j < c.length && end === -1; j++) {
      if (v(c, j) < v(c, low)) low = j;
      if (v(c, j) >= v(c, h) || v(c, j) >= (1 + rise) * v(c, low)) end = j;
    }
    const open = end === -1;
    const last = open ? c.length - 1 : end;
    let trough = i;
    for (let j = i + 1; j <= last; j++) if (v(c, j) < v(c, trough)) trough = j;
    if (c[i]!.date >= k.FROM) out.push({ shockStart: c[start]!.date, exit: c[i]!.date, end: c[last]!.date, open, drop, rise, shape: trough - i > k.SHAPE_N ? "BEAR" : "V", troughLag: trough - i });
    if (open) break;
    h = end;
    i = end;
  }
  return out;
}

export const priceAt = (px: Pt[], d: string): number => closes(px).findLast((p) => p.date <= d)!.value!;

/** Per fill: the lowest close after it to the episode end, and the end close, each ÷ the fill close − 1. */
export type Drop = { trough: number; end: number };
export type EpisodeResult = Episode & { hold: number; ret: number; fills: (string | null)[]; drops: (Drop | null)[] };

export function fillDrops(px: Pt[], fills: (string | null)[], end: string): (Drop | null)[] {
  const c = closes(px).filter((p) => p.date <= end);
  return fills.map((d) => {
    if (d === null) return null;
    const at = priceAt(px, d);
    const after = c.filter((p) => p.date > d).map((p) => p.value!);
    return { trough: Math.min(0, ...after.map((x) => x / at - 1)), end: priceAt(px, end) / at - 1 };
  });
}

/** Sold at the exit close, one third bought back at each fill's close, marked at the episode end over leg price `px`; cash = 0. */
export function scoreEpisode(px: Pt[], e: Episode, fills: (string | null)[]): EpisodeResult {
  const end = priceAt(px, e.end);
  const ret = fills.reduce((sum, d) => sum + (d === null ? 0 : (end / priceAt(px, d) - 1) / fills.length), 0);
  return { ...e, hold: end / priceAt(px, e.exit) - 1, ret, fills, drops: fillDrops(px, fills, e.end) };
}

export const replayTotals = (rows: EpisodeResult[], key: "hold" | "ret"): { bear: number; all: number } => ({
  bear: rows.filter((x) => x.shape === "BEAR").reduce((a, x) => a + x[key], 0),
  all: rows.reduce((a, x) => a + x[key], 0),
});

/** EU-Fin's holdout window, every leg's: a verdict id under `MIN_COVER` × the leg price's in-window closes is short; under `THIN_BEARS` bear episodes is thin. */
export const HOLDOUT_WINDOW = { FROM: "2018-07-12", TO: "2021-10-31", FEED_FROM: "2016-01-04", THIN_BEARS: 3, MIN_COVER: 0.9 };

/** The replay pass rule, every leg's (EU-Fin's `ARM.PASS_*` alias it): the worst bear episode's return at or above `WORST_BEAR`, every fill's trough (`Drop.trough`) at or above `WORST_FILL_DROP`; fixed before the first read. */
export const PASS = { WORST_BEAR: -0.03, WORST_FILL_DROP: -0.15 } as const;

/** A replay's stored `/api/series` read limit. */
export const DEEP_LIMIT = 4000;

/** `realBears` = episodes whose hold return is < 0, any shape. */
export function holdoutVerdict(rows: EpisodeResult[]): { bears: number; realBears: number; worstBear: number; worstFill: number; pass: boolean; thin: boolean } {
  const bears = rows.filter((x) => x.shape === "BEAR");
  const worstBear = Math.min(0, ...bears.map((x) => x.ret));
  const worstFill = Math.min(0, ...rows.flatMap((x) => x.drops.flatMap((d) => (d === null ? [] : [d.trough]))));
  const pass = worstBear >= PASS.WORST_BEAR && worstFill >= PASS.WORST_FILL_DROP && bears.some((x) => x.fills.some((d) => d !== null));
  return { bears: bears.length, realBears: rows.filter((x) => x.hold < 0).length, worstBear, worstFill, pass, thin: bears.length < HOLDOUT_WINDOW.THIN_BEARS };
}

/** The window's printed verdict: THIN (under `THIN_BEARS` bears, or any verdict id `short` of `MIN_COVER` × the fund's closes) outranks PASS/FAIL — a window is never silently shortened. */
export type Acceptance = "PASS" | "FAIL" | "THIN";
export const acceptance = (vd: { pass: boolean; thin: boolean }, short: readonly string[]): Acceptance => (vd.thin || short.length > 0 ? "THIN" : vd.pass ? "PASS" : "FAIL");

export type ReplayMode = "verdict" | "drift" | "p0" | "why";
/** `--replay=<arg>`: `holdout` | `sweep`, bare (the verdict) or behind `drift:` / `p0:` / `why:`; anything else throws. */
export function replayMode(arg: string): { mode: ReplayMode; window: "holdout" | "sweep" } {
  const at = arg.indexOf(":");
  const pre = at < 0 ? "" : arg.slice(0, at);
  const mode: ReplayMode | undefined = pre === "" ? "verdict" : pre === "drift" || pre === "p0" || pre === "why" ? pre : undefined;
  const window = mode === undefined || mode === "verdict" ? arg : arg.slice(at + 1);
  if (mode === undefined || (window !== "holdout" && window !== "sweep")) throw new Error(`--replay=${arg}: holdout | sweep | drift:holdout | drift:sweep | p0:holdout | p0:sweep | why:holdout | why:sweep`);
  return { mode, window };
}
/** The scored window and its feed start: holdout = `HOLDOUT_WINDOW` (feeds from `FEED_FROM`), sweep = `REPLAY.FROM` → `today` (feeds from the start). */
export const replayWindow = (window: "holdout" | "sweep", today: string): { from: string; to: string; feedFrom: string } =>
  window === "holdout" ? { from: HOLDOUT_WINDOW.FROM, to: HOLDOUT_WINDOW.TO, feedFrom: HOLDOUT_WINDOW.FEED_FROM } : { from: REPLAY.FROM, to: today, feedFrom: "" };
/** The replay's last line: worst bear and worst fill vs `PASS` → the acceptance, THIN naming its causes. */
export function verdictLine(rows: EpisodeResult[], short: readonly string[]): string {
  const vd = holdoutVerdict(rows);
  const verdict = acceptance(vd, short);
  const why = [...(vd.thin ? [`${vd.bears} bear episodes`] : []), ...short.map((id) => `${id} short`)];
  return `worst bear ${pct(vd.worstBear)} vs ${pct(PASS.WORST_BEAR)} · worst fill trough ${pct(vd.worstFill)} vs ${pct(PASS.WORST_FILL_DROP)} → ${verdict} · ${vd.realBears} real bear(s)${verdict === "THIN" ? ` · THIN: ${why.join(", ")}` : ""}`;
}

/** Upstream vs the stored series' final closes only — an `estimated` / `provisional` stored row is no close to compare. */
export function parity(up: Pt[], stored: Pt[]): { n: number; max: number } {
  const at = new Map(closes(stored).map((p) => [p.date, p.value]));
  const d = up.flatMap((p) => ((v) => (v === null || v === undefined || p.value === null ? [] : [Math.abs(p.value - v)]))(at.get(p.date)));
  return { n: d.length, max: Math.max(0, ...d) };
}

export const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
/** A knob's float arithmetic without its binary noise: 1 − 0.07 → `0.93`. */
export const knob = (x: number): string => String(+x.toPrecision(6));
export const last = (c: Pt[]): Pt | undefined => c.at(-1);
export const vals = (c: Pt[]): number[] => c.map((p) => p.value!);

/** `f` over each of `ids`' series in `s`, a missing id read as none — a leg binds its own ids (`eachId`). */
export const eachSeries = <S>(ids: readonly string[], s: S, f: (c: Pt[]) => Pt[]): S => Object.fromEntries(ids.map((id) => [id, f((s as Record<string, Pt[] | undefined>)[id] ?? [])])) as S;
/** A series cut to its points on or before `d`. */
export const upTo = (d: string) => (c: Pt[]): Pt[] => c.filter((p) => p.date <= d);
/** A series cut `PRE_DAYS` before the episode's shock through its `end`. */
export const episodeWindow = (e: Pick<Episode, "shockStart" | "end">, k: ReplayKnobs): ((c: Pt[]) => Pt[]) =>
  ((from) => (c: Pt[]) => c.filter((p) => p.date >= from && p.date <= e.end))(isoDay(new Date(Date.parse(e.shockStart) - k.PRE_DAYS * 86_400_000)));
/** Every id in `ids` through `get`, in parallel, as one set. */
export const fetchEach = async <K extends string>(ids: readonly K[], get: (id: K) => Promise<Pt[]>): Promise<Record<K, Pt[]>> => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await get(id)] as const))) as Record<K, Pt[]>;

export function sweepTable(rows: EpisodeResult[]): string {
  const t = { hold: replayTotals(rows, "hold"), ret: replayTotals(rows, "ret") };
  const nBear = rows.filter((x) => x.shape === "BEAR").length;
  return [
    "sold        end         shape  low@  hold     rules    fills (trough/end)   * = hold < 0",
    ...rows.map((x) => `${x.exit}  ${x.end}  ${(x.shape + (x.hold < 0 ? "*" : "")).padEnd(5)}  ${String(x.troughLag).padStart(4)}  ${pct(x.hold).padStart(7)}  ${pct(x.ret).padStart(7)}  ${x.fills.map((d, i) => (d === null ? "—" : `${d.slice(5)} ${((q) => (q ? `${pct(q.trough)}/${pct(q.end)}` : ""))(x.drops[i])}`)).join(" · ")}`),
    `bear total (${nBear})`.padEnd(37) + `${pct(t.hold.bear).padStart(7)}  ${pct(t.ret.bear).padStart(7)}`,
    `all (${rows.length})`.padEnd(37) + `${pct(t.hold.all).padStart(7)}  ${pct(t.ret.all).padStart(7)}`,
  ].join("\n");
}

/** One fill's own rows at its fill close (`--replay=why:<window>`): leg-agnostic, each leg's probe builds the rows. */
export type WhyRow = { exit: string; tranche: string; date: string; trough: number | null; rows: { key: string; gate: boolean; verdict: string }[]; via: string };
/** A fill close's rows and its tranche's tally, as the leg's `legsAt` / `tally` read them. */
export type FillRead = { legs: readonly { tranche: string; key: string; gate: boolean; verdict: string }[]; res: { ready: boolean; clear: boolean; metCount: number; need: number } };
const TRANCHES = ["T1", "T2", "T3"] as const;
/** A follow-path leg's why rows: `count met/need` when ready, else `via[i]` once clear and `after[i]` `fund` closes passed since the exit / the prior fill; else throws. */
export function whyFollow(rows: readonly EpisodeResult[], fund: (e: EpisodeResult) => Pt[], read: (e: EpisodeResult, d: string, t: (typeof TRANCHES)[number]) => FillRead, via: readonly string[], after: readonly number[]): WhyRow[] {
  return rows.flatMap((e) => e.fills.flatMap((d, i): WhyRow[] => {
    if (d === null) return [];
    const t = TRANCHES[i]!;
    const { legs, res } = read(e, d, t);
    // The replay passes fizzled = false; `since` = the exit / the prior tranche's fill as the leg's `firesAt` saw it before this close.
    const since = i === 0 ? e.exit : ((f) => (f !== null && f < d ? f : null))(e.fills[i - 1] ?? null);
    const elapsed = since !== null && fund(e).filter((p) => p.date > since && p.date <= d).length >= after[i]!;
    const route = res.ready ? `count ${res.metCount}/${res.need}` : res.clear && elapsed ? via[i]! : null;
    if (route === null) throw new Error(`whyFills: ${t} ${d} filled with neither its count nor its ${via[i]} route`);
    return [{ exit: e.exit, tranche: t, date: d, trough: e.drops[i]?.trough ?? null, rows: legs.filter((l) => l.tranche === t).map((l) => ({ key: l.key.replace(/^t\d-/, ""), gate: l.gate, verdict: l.verdict })), via: route }];
  }));
}
const mark = (v: string): string => (v === "met" ? "✓" : v === "na" ? "·" : "✗");
export const whyTable = (rows: readonly WhyRow[]): string =>
  ["sold        tranche  fill   trough   criteria (✓ met, · n/a, ✗ unmet) | gates | route",
    ...rows.map((w) => `${w.exit}  ${w.tranche.padEnd(7)}  ${w.date.slice(5)}  ${(w.trough === null ? "—" : pct(w.trough)).padStart(6)}   ${w.rows.filter((r) => !r.gate).map((r) => `${r.key}${mark(r.verdict)}`).join(" ")} | ${w.rows.filter((r) => r.gate).map((r) => `${r.key}${mark(r.verdict)}`).join(" ")} | ${w.via}`)].join("\n");

export const stopRow = (name: string, rows: EpisodeResult[]): string =>
  ((vd) => `${name.padEnd(20)} worst bear ${pct(vd.worstBear).padStart(6)}  worst fill ${pct(vd.worstFill).padStart(6)}  all ${pct(replayTotals(rows, "ret").all).padStart(7)}`)(holdoutVerdict(rows));

/** Fill drift (`DRIFT`): a candidate form's fills against the shipped form's, per episode × tranche, Δ in the leg price's `closes()` index space; a null-vs-filled pair is a mismatch, never a number. PASS = 0 mismatches ∧ every max |Δ| ≤ `K`. */
export const DRIFT = { K: 3 } as const;
export type ReplayRun = (k: ReplayKnobs) => EpisodeResult[];
export type DriftRow = { exit: string; tranche: number; shipped: string | null; candidate: string | null; delta: number | null; mismatch: boolean };

/** Runs both forms on `k`; throws unless their `exit` lists are equal in order — drift is only defined over the same episodes.
 *  A fill is read at the leg price's last close ≤ its date (`priceAt`'s convention — a fill calendar can carry days the leg's own exchange lacks); throws only when no close precedes it.
 *  Two runs over one `armReplay` `cache` share memo keys that omit `fastAt`/`fastDefs` — give each `ReplayRun` its own cache. */
export function fillDrift(px: Pt[], shipped: ReplayRun, candidate: ReplayRun, k: ReplayKnobs = REPLAY): DriftRow[] {
  const a = shipped(k);
  const b = candidate(k);
  const exits = (rows: EpisodeResult[]): string => rows.map((x) => x.exit).join(",");
  if (exits(a) !== exits(b)) throw new Error(`fillDrift: exit lists differ — shipped [${exits(a)}] vs candidate [${exits(b)}]`);
  const c = closes(px);
  const at = (d: string): number => {
    const i = c.findLastIndex((p) => p.date <= d);
    if (i === -1) throw new Error(`fillDrift: fill ${d} precedes every close of the leg price`);
    return i;
  };
  return a.flatMap((s, n) =>
    s.fills.map((sf, t) => {
      const cf = b[n]!.fills[t] ?? null;
      const mismatch = (sf === null) !== (cf === null);
      const delta = mismatch ? null : sf === null || cf === null ? 0 : at(cf) - at(sf);
      return { exit: s.exit, tranche: t + 1, shipped: sf, candidate: cf, delta, mismatch };
    }),
  );
}

/** `filled` = the shipped form's non-null fills, `episodes` = distinct exits; `pass` needs `filled > 0` — a run that fills nothing cannot drift and prints THIN, never PASS. */
export function driftSummary(rows: DriftRow[]): { maxAbs: [number, number, number]; mismatches: number; filled: number; episodes: number; pass: boolean } {
  const maxAbs = [1, 2, 3].map((t) => Math.max(0, ...rows.flatMap((r) => (r.tranche === t && r.delta !== null ? [Math.abs(r.delta)] : [])))) as [number, number, number];
  const mismatches = rows.filter((r) => r.mismatch).length;
  const filled = rows.filter((r) => r.shipped !== null).length;
  const episodes = new Set(rows.map((r) => r.exit)).size;
  return { maxAbs, mismatches, filled, episodes, pass: filled > 0 && mismatches === 0 && maxAbs.every((x) => x <= DRIFT.K) };
}

/** Only the rows that moved (Δ ≠ 0 or a mismatch), then the summary line. */
export function driftTable(rows: DriftRow[]): string {
  const s = driftSummary(rows);
  const moved = rows.filter((r) => r.mismatch || r.delta !== 0);
  return [
    ...moved.map((r) => `${r.exit}  T${r.tranche}  ${r.shipped ?? "—"} → ${r.candidate ?? "—"}  ${r.mismatch ? "MISMATCH" : `Δ ${r.delta! > 0 ? "+" : ""}${r.delta}`}`),
    `max |Δ| T1/T2/T3 ${s.maxAbs.join("/")} · mismatches ${s.mismatches} · filled ${s.filled}/${s.episodes} → DRIFT ${s.filled === 0 ? "THIN" : s.pass ? "PASS" : "FAIL"} (k=${DRIFT.K})`,
  ].join("\n");
}

/** Box binding days: esc = a later close ≤ `ESC_FRAC` × the day's close, on/before the episode end. */
export const BINDING = { ESC_FRAC: 0.85 } as const;

export function classifyBinding(px: Pt[], ep: Pick<Episode, "end">, days: readonly string[]): { esc: number; fizzle: number } {
  const c = closes(px).filter((p) => p.date <= ep.end);
  const esc = days.filter((d) => ((at) => c.some((p) => p.date > d && p.value! <= BINDING.ESC_FRAC * at))(priceAt(px, d))).length;
  return { esc, fizzle: days.length - esc };
}

export type BindingRow = { arm: string; esc: number; fizzle: number; pass: boolean; acceptance: Acceptance };

export const bindingTable = (rows: readonly BindingRow[]): string =>
  ["arm                  esc-blocked  fizzle-blocked  holdout  acceptance", ...rows.map((r) => `${r.arm.padEnd(20)} ${String(r.esc).padStart(11)}  ${String(r.fizzle).padStart(14)}  ${(r.pass ? "pass" : "fail").padStart(7)}  ${r.acceptance}`)].join("\n");
