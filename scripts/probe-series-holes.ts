/**
 * Persistence-hole sweep — `npm run probe:series-holes -- --from=YYYY-MM-DD --to=YYYY-MM-DD [--base=]`.
 * Lists weekdays missing from each daily registry id on prod `/api/series` inside `[from, min(to, newest)]`, and
 * ids whose newest final row trails `to` past `restateTailMaxAgeDays(id)`. Provisional rows count as absent. Exit 1 on a hole that neither the id's market calendar
 * (`isSourceHoliday`, src/source-holidays.ts), `UPSTREAM_HOLES` nor `LATE_START` excuses, or a stale id; exit 2 on usage/fetch error.
 * `--tail [--asof=YYYY-MM-DD]` (`tailViolations`): per `ANCHOR_ROSTER` id (`tailRoster`), FAIL on
 * an `estimated` row whose previous session holds no FINAL row — a session with no row is the expected gap — on an id
 * serving no row at all in the window, or on an id `/api/series` does not serve (`tailRoster().unserved`, never skipped).
 */
import type { Indicator } from "../src/domain-types.js";
import { ANCHOR_ROSTER, unanchoredEstimateDates } from "../src/estimated.js";
import { provisionalBefore } from "../src/intraday.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.js";
import { restateTailMaxAgeDays } from "../src/run-seeds.js";
import { isSourceHoliday, prevSession } from "../src/source-holidays.js";
import { isoDay } from "../src/dates.js";
import { META } from "../src/api/http.js";
import { CHAINED_SERIES_HEAD } from "../src/api-routes/series-chained.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

// Dates the upstream feed itself never printed (the sovereign-yield quote feed's own history) — gap-fill cannot fill them.
export const UPSTREAM_HOLES: Readonly<Record<string, readonly string[]>> = {
  BUND: ["2026-08-20", "2026-08-24"],
  BONOS: ["2026-08-20", "2026-08-24"],
};

// Ids whose prod history may start as late as this date — delete the row once its backfill lands.
const LATE_START: Readonly<Record<string, string>> = {};

const MAX_LIMIT = 4000;
const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const isDaily = (i: Indicator): boolean => (i.obsCadence ?? i.cadence ?? "daily") === "daily";

// `/api/series` serves registry + chart-only ids only (components 400).
export const dailyIds = (): string[] => [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].filter(isDaily).map((i) => i.id);

export function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(isoDay(d));
  }
  return out;
}

export function excused(id: string, date: string): boolean {
  if (UPSTREAM_HOLES[id]?.includes(date)) return true;
  return isSourceHoliday(id, date);
}

/** Weekdays in `[from, min(to, newest)]` absent from `dates`; the window opens at `oldest` only up to `LATE_START[id]`. */
export function holes(id: string, dates: readonly string[], from: string, to: string): string[] {
  const have = new Set(dates);
  const sorted = [...dates].sort();
  const late = LATE_START[id];
  const lo = late !== undefined && sorted[0]! > from && sorted[0]! <= late ? sorted[0]! : from;
  const hi = sorted.at(-1)! < to ? sorted.at(-1)! : to;
  return weekdays(lo, hi).filter((d) => !have.has(d));
}

/** Calendar days from `newest` to `to` past the id's own lag allowance — > 0 reads STALE. */
export function staleDays(id: string, newest: string, to: string): number {
  return (Date.parse(to) - Date.parse(newest)) / 86_400_000 - restateTailMaxAgeDays(id);
}

type WirePoint = { date: string; provisional?: true; estimated?: true };

/** `id`'s rows breaking "an estimate on t needs a FINAL row on t's previous session" (weekday, not its source holiday); an empty series is itself a violation (it would otherwise pass vacuously). */
export function tailViolations(id: string, points: readonly WirePoint[]): string[] {
  if (points.length === 0) return ["empty-series"];
  // The wire carries `provisional`, not `run_at`: an unflagged row was written at or past its date's cutoff.
  const rows = points.map((p) => ({ date: p.date, estimated: p.estimated, runAt: p.provisional === true ? `${p.date}T00:00:00.000Z` : provisionalBefore(p.date, id) }));
  return unanchoredEstimateDates(id, rows).map((d) => `${d}:estimate-without-${prevSession(id, d)}-final`);
}

const monthStart = (d: string): string => `${d.slice(0, 7)}-01`;
const nextMonthStart = (d: string): string => {
  const [y, m] = d.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

// Reads from 14 days before `from`, so a hole on the window's first weekday is not mistaken for the series' start.
async function fetchPoints(base: string, id: string, from: string, to: string): Promise<WirePoint[]> {
  const head = isoDay(new Date(Date.parse(from) - 14 * 86_400_000));
  const url = `${base}/api/series?id=${id}&limit=${MAX_LIMIT}&from=${monthStart(head)}&to=${nextMonthStart(to)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return ((await res.json()) as { points: WirePoint[] }).points;
}

async function fetchDates(base: string, id: string, from: string, to: string): Promise<string[]> {
  return (await fetchPoints(base, id, from, to)).filter((p) => !p.provisional).map((p) => p.date);
}

/** The `ANCHOR_ROSTER` ids `/api/series` serves (`META` + the chained-only `CHAINED_SERIES_HEAD`) — `served` is swept;
 *  `unserved` would 400 on that endpoint, so `mainTail` FAILs on it (named, not aborted on the first) — empty by contract. */
const servedBySeries = (id: string): boolean => META.has(id) || CHAINED_SERIES_HEAD.has(id);
export function tailRoster(): { served: string[]; unserved: string[] } {
  return { served: ANCHOR_ROSTER.filter(servedBySeries), unserved: ANCHOR_ROSTER.filter((id) => !servedBySeries(id)) };
}

async function mainTail(base: string): Promise<void> {
  const asOf = flag("asof") ?? isoDay(new Date());
  const from = isoDay(new Date(Date.parse(asOf) - 30 * 86_400_000));
  const { served, unserved } = tailRoster();
  if (unserved.length > 0) console.log(`BAD     not served by /api/series: ${unserved.join(" ")}`);
  let bad = unserved.length;
  for (let i = 0; i < served.length; i += 8) {
    const batch = served.slice(i, i + 8);
    const pts = await Promise.all(batch.map((id) => fetchPoints(base, id, from, asOf)));
    batch.forEach((id, k) => {
      const v = tailViolations(id, pts[k]!);
      if (v.length > 0) console.log(`BAD     ${id}: ${v.join(" ")}`);
      bad += v.length > 0 ? 1 : 0;
    });
  }
  console.log(`${served.length} daily ids, tail to ${asOf}: ${bad === 0 ? "PASS" : `FAIL — ${bad} id(s) unserved, or with an unanchored estimate or an empty series`}`);
  process.exit(bad === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--tail")) return mainTail(flag("base") ?? prodBaseUrl());
  const from = flag("from");
  const to = flag("to");
  if (!from || !to) {
    console.error("usage: --from=YYYY-MM-DD --to=YYYY-MM-DD [--base=]");
    process.exit(2);
  }
  const base = flag("base") ?? prodBaseUrl();
  const ids = dailyIds();
  const found = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8);
    const dates = await Promise.all(batch.map((id) => fetchDates(base, id, from, to)));
    batch.forEach((id, k) => found.set(id, dates[k]!));
  }
  let bad = 0;
  for (const [id, dates] of found) {
    if (dates.length === 0) {
      console.log(`EMPTY   ${id}`);
      bad++;
      continue;
    }
    const newest = [...dates].sort().at(-1)!;
    const stale = staleDays(id, newest, to);
    const h = holes(id, dates, from, to);
    const unexcused = h.filter((d) => !excused(id, d));
    if (unexcused.length > 0 || stale > 0) bad++;
    if (stale > 0) console.log(`STALE   ${id}: newest final ${newest}, ${stale}d past its lag allowance at ${to}`);
    if (h.length > 0)
      console.log(`${unexcused.length > 0 ? "HOLE   " : "ok     "} ${id}: ${h.map((d) => (excused(id, d) ? `(${d})` : d)).join(" ")}`);
  }
  console.log(`${found.size} daily ids, ${from} → ${to}: ${bad === 0 ? "PASS" : `FAIL — ${bad} id(s) with unexcused holes or stale`}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`)
  await main().catch((e: unknown) => {
    console.error(`ERROR ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
