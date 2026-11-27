/** Shared shock geometry for the ladder probes — a leaf over `ladder-replay.ts` only, so every leg's probe can import it without a cycle. */
import { closes, episodes, REPLAY, v, type Episode, type Pt } from "./ladder-replay.js";

export const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
/** Sample sd (n − 1) — the same estimator as the scorer's σ (`velocitySigmaZSeries`, domain-fold.ts). */
export const sd = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((acc, x) => acc + (x - m) ** 2, 0) / (a.length - 1));
};
export const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Max close on/after `since`. */
export function peakSince(pts: Pt[], since: string): { value: number; date: string } | null {
  let peak: { value: number; date: string } | null = null;
  for (const p of closes(pts)) if (p.date >= since && (peak === null || p.value! > peak.value)) peak = { value: p.value!, date: p.date };
  return peak;
}

/** Shared by every leg: a shock period's anchor = the lowest close among the SHOCK_LOW_N closes before the crossing close. */
export const SHOCK_LOW_N = 60;

/** `start` = the period's anchor date; `open` = no close ≤ base since it opened; `closedAt` = the close that closed it (null ⇔ open); `broke` is true by construction (a period opens only on a BROKE_SD σ crossing) — kept for the callers' n/a guard. */
export type Shock = { start: string; open: boolean; closedAt: string | null; base: number; peak: number; peakDate: string; last: number; lastDate: string; sigma: number; broke: boolean };
export type ShockKnobs = { BASE_N: number; SIGMA_N: number; BROKE_SD: number };

type Period = { s: number; base: number; sigma: number };
type Stat = { base: number; sigma: number } | null;
/** One series' causal period walk: entry i = the state as of close i, so any prefix reads its own last entry. */
type Timeline = { c: Pt[]; stat: Stat[]; hit: boolean[]; per: (Period | null)[]; open: boolean[]; pk: number[]; cl: number[] };

/** base = median of the BASE_N closes before anchor j; σ = sd of the SIGMA_N daily Δ before it; null short of either. */
function statAt(t: Timeline, j: number, r: ShockKnobs): Stat {
  if (t.stat[j] !== undefined) return t.stat[j]!;
  const c = t.c;
  const s: Stat =
    j < r.BASE_N || j < r.SIGMA_N + 1
      ? null
      : {
          base: median(c.slice(j - r.BASE_N, j).map((p) => p.value!)),
          sigma: sd(c.slice(j - r.SIGMA_N - 1, j).flatMap((p, k, a) => (k ? [p.value! - a[k - 1]!.value!] : []))),
        };
  t.stat[j] = s;
  return s;
}

/** Close i of the walk: close an open period on a close ≤ its base, then open one on a fresh crossing, anchored on the lowest of the SHOCK_LOW_N closes before i (latest on a tie). */
function step(t: Timeline, i: number, r: ShockKnobs): void {
  const c = t.c;
  let a = -1;
  if (i >= SHOCK_LOW_N) {
    a = i - 1;
    for (let k = i - 2; k >= i - SHOCK_LOW_N; k--) if (v(c, k) < v(c, a)) a = k;
  }
  const st = a < 0 ? null : statAt(t, a, r);
  const hit = st !== null && v(c, i) - st.base >= r.BROKE_SD * st.sigma;
  let [per, open, pk, cl] = i ? [t.per[i - 1]!, t.open[i - 1]!, t.pk[i - 1]!, t.cl[i - 1]!] : [null, false, -1, -1];
  if (per !== null && open && v(c, i) <= per.base) [open, cl] = [false, i];
  if (hit && !(i > 0 && t.hit[i - 1])) {
    per = { s: a, base: st.base, sigma: st.sigma };
    [open, cl] = [true, -1];
    pk = a;
    for (let k = a + 1; k <= i; k++) if (v(c, k) > v(c, pk)) pk = k;
  } else if (per !== null && v(c, i) > v(c, pk)) pk = i;
  t.hit[i] = hit;
  t.per[i] = per;
  t.open[i] = open;
  t.pk[i] = pk;
  t.cl[i] = cl;
}

/** Replays read prefixes of one series once per day: the walk is kept per (first close, knobs) and extended or cut back to the longest shared prefix (by Pt identity). */
const TIMELINES = new WeakMap<Pt, Map<string, Timeline>>();
function timeline(c: Pt[], r: ShockKnobs): Timeline {
  const key = `${r.BASE_N}|${r.SIGMA_N}|${r.BROKE_SD}`;
  let byKnobs = TIMELINES.get(c[0]!);
  if (byKnobs === undefined) TIMELINES.set(c[0]!, (byKnobs = new Map()));
  let t = byKnobs.get(key);
  if (t === undefined) byKnobs.set(key, (t = { c: [], stat: [], hit: [], per: [], open: [], pk: [], cl: [] }));
  const n = Math.min(t.c.length, c.length);
  let m = 0;
  while (m < n && t.c[m] === c[m]) m++;
  if (m < c.length) {
    for (const a of [t.c, t.hit, t.per, t.open, t.pk, t.cl]) a.length = m;
    t.stat.length = Math.min(t.stat.length, m + 1);
    for (let i = m; i < c.length; i++) {
      t.c.push(c[i]!);
      step(t, i, r);
    }
  }
  return t;
}

/** The series' latest shock period, open or closed — null when none ever opened. base/σ = at its anchor (`start`); peak = max close since `start`; last = newest close (the skill's prose quotes these, never a news figure). */
export function shockOf(pts: Pt[], r: ShockKnobs): Shock | null {
  const c = closes(pts);
  if (c.length === 0) return null;
  const t = timeline(c, r);
  const i = c.length - 1;
  const per = t.per[i]!;
  if (per === null) return null;
  const peak = c[t.pk[i]!]!;
  const cl = t.cl[i]!;
  return { start: c[per.s]!.date, open: t.open[i]!, closedAt: cl < 0 ? null : c[cl]!.date, base: per.base, peak: peak.value!, peakDate: peak.date, last: v(c, i), lastDate: c[i]!.date, sigma: per.sigma, broke: peak.value! - per.base >= r.BROKE_SD * per.sigma };
}

/** The series' `shockOf` as graded against `exit` (a retired plan) — a period closed before the exit is no shock (null); open, or opened on/after it, stands. */
export function shockSince(pts: Pt[], r: ShockKnobs, exit: string): Shock | null {
  const sh = shockOf(pts, r);
  return sh !== null && sh.closedAt !== null && sh.closedAt < exit ? null : sh;
}

/** Vol-normal rungs (a retired plan, Stage 4.1): the cut = VOL_K × the median; the cooling branch = ≤ (1 − VOL_COOL) × the shock's peak. Replay-set (Stage 4.2). */
export const VOL_K = 1.2;
export const VOL_COOL = 0.25;
export type VolNormal = { median: number; n: number; cut: number; anchored: boolean; cooling: boolean; shock: Shock | null };

/** Shared by every leg's vol-normal rung over `vol` as the site reads it (its run stays the caller's, on `v < cut`, the median fixed as of the last close).
 *  The vol series' own `shockOf` open → the median of the `medianN` closes strictly before `Shock.start` (`anchored`), and `cooling` = the last close ≤ (1 − VOL_COOL) × `Shock.peak` and falling ×2 (c[i] < c[i−1] < c[i−2]);
 *  none open → the rolling median of the last `medianN`, `cooling` false. `n` = the window's length (a site needing a full window reads n < medianN as its n/a); null on an empty window. */
export function volNormal(vol: Pt[], knobs: ShockKnobs, medianN: number): VolNormal | null {
  const shock = shockOf(vol, knobs);
  const anchored = shock !== null && shock.open;
  const j = anchored ? vol.findIndex((p) => p.date >= shock.start) : vol.length;
  const w = vol.slice(Math.max(0, j - medianN), j).map((p) => p.value!);
  if (w.length === 0) return null;
  const m = median(w);
  const i = vol.length - 1;
  const cooling = anchored && i >= 2 && v(vol, i) <= (1 - VOL_COOL) * shock.peak && v(vol, i) < v(vol, i - 1) && v(vol, i - 1) < v(vol, i - 2);
  return { median: m, n: w.length, cut: VOL_K * m, anchored, cooling, shock };
}

/** Δ(SPEED_N) at close i and its max over the closes since `since` (the series' own `Shock.start`) up to i (−∞ before it), with the max's close date (latest on a tie; null at −∞). */
export function speedAt(c: Pt[], i: number, r: { SPEED_N: number }, since: string): { d: number | null; max: number; maxDate: string | null } {
  const d = (k: number): number | null => (k >= r.SPEED_N ? v(c, k) - v(c, k - r.SPEED_N) : null);
  let [max, maxDate] = [-Infinity, null as string | null];
  for (let k = i; k >= 0 && c[k]!.date >= since; k--) if ((d(k) ?? -Infinity) > max) [max, maxDate] = [d(k)!, c[k]!.date];
  return { d: d(i), max, maxDate };
}

/** Per first close: the longest series walked and its episodes (FROM off); a prefix of it is read off them, a longer series re-walks. */
const WALKS = new WeakMap<Pt, { c: Pt[]; eps: Episode[] }>();
/** Per input array (rows read many times a close): its read, kept while its length holds. */
const READS = new WeakMap<Pt[], { n: number; s: string | null }>();

/** Sliding-reference anchor (a retired plan): the price episode open as of the last close (or `asOf`) — exit ≤ it, no end yet — its `shockStart`, else null (the caller keeps its rolling read).
 *  `REPLAY.FROM` is not applied: replays run pre-2021 windows. */
export function openShockStart(px: Pt[], asOf?: string): string | null {
  if (asOf === undefined) {
    const hit = READS.get(px);
    if (hit !== undefined && hit.n === px.length) return hit.s;
  }
  const c = asOf === undefined ? closes(px) : closes(px).filter((p) => p.date <= asOf);
  const s = c.length === 0 ? null : walkRead(c);
  if (asOf === undefined) READS.set(px, { n: px.length, s });
  return s;
}

function walkRead(c: Pt[]): string | null {
  let w = WALKS.get(c[0]!);
  if (w === undefined || w.c.length < c.length || c.some((p, i) => p !== w!.c[i])) WALKS.set(c[0]!, (w = { c, eps: episodes(c, { ...REPLAY, FROM: "" }) }));
  const d = c.at(-1)!.date;
  return w.eps.find((e) => e.exit <= d && (e.open || e.end > d))?.shockStart ?? null;
}

/** Anchored off-high: last close vs the close at the open episode's `shockStart` (≡ the max since, as the episode ends on regaining it); null when none is open. */
export function shockOffHigh(c: Pt[]): { dd: number; high: number; highDate: string } | null {
  const s = openShockStart(c);
  const [top, last] = [s === null ? undefined : c.find((p) => p.date === s), c.at(-1)];
  return top === undefined || last === undefined ? null : { dd: last.value! / top.value! - 1, high: top.value!, highDate: top.date };
}

/** Hybrid guards (`HYBRID_GUARDS`): wave 2 trips once back past this share of the way from the turn to the since-shock extreme. */
export const HALF = 0.5;
export type HybridLine = { line: number; ext: number; extDate: string; turn: number | null };

/** At close i after `start`: ext = the `side` extreme of the closes from `start` to before i (latest on a tie); turn = the opposite extreme strictly between ext and i;
 *  line = turn + HALF·(ext − turn) (ext with no turn), so a close past it — or a new since-shock extreme — breaks. null with no `start`, at/before it, or no close since → the caller's rolling read. */
export function hybridLine(c: Pt[], i: number, side: "high" | "low", start: string | null): HybridLine | null {
  if (start === null || c[i]!.date <= start) return null;
  const j = c.findIndex((p) => p.date >= start);
  if (j >= i) return null;
  const worse = (a: number, b: number): boolean => (side === "high" ? a > b : a < b);
  let e = j;
  for (let k = j + 1; k < i; k++) if (!worse(v(c, e), v(c, k))) e = k;
  let t = -1;
  for (let k = e + 1; k < i; k++) if (t < 0 || worse(v(c, t), v(c, k))) t = k;
  const [ext, turn] = [v(c, e), t < 0 ? null : v(c, t)];
  return { line: turn === null ? ext : turn + HALF * (ext - turn), ext, extDate: c[e]!.date, turn };
}

/** Close i breaks the hybrid guard: past its `hybridLine`; null where that is null (the caller's rolling `newExtreme`). */
export const hybridBreak = (c: Pt[], i: number, side: "high" | "low", start: string | null): boolean | null =>
  ((h) => (h === null ? null : side === "high" ? v(c, i) > h.line : v(c, i) < h.line))(hybridLine(c, i, side, start));

/** The last close's hybrid line as a dated cut (`vcAt`'s shape, dated at the since-shock extreme); null → the caller's rolling `priorExt`. */
export const hybridCut = (c: Pt[], side: "high" | "low", start: string | null): { value: number; date: string } | null =>
  ((h) => (h === null ? null : { value: h.line, date: h.extDate }))(c.length ? hybridLine(c, c.length - 1, side, start) : null);

/** The guard's anchor: a spread's own open `shockOf` start (`knobs` given), a ratio's open `openShockStart` (none); null when `on` is off or no shock is open. */
export function guardAnchor(c: Pt[], on: boolean, knobs?: ShockKnobs): string | null {
  if (!on) return null;
  if (knobs === undefined) return openShockStart(c);
  const sh = shockOf(c, knobs);
  return sh !== null && sh.open ? sh.start : null;
}

/** A guard row's rule text: `on` → the since-shock `hybridLine`, rolling `n`-close extreme while no shock is open; off → rolling only. */
export const guardRule = (side: "high" | "low", n: number, run: number, on: boolean): string =>
  on ? `no close past its since-shock ${HALF * 100}% line ×${run} (no shock open: no ${n}-close ${side})` : `no ${n}-close ${side} ×${run}`;
